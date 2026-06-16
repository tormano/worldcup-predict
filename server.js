const express = require('express');
const Database = require('better-sqlite3');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const db = new Database('worldcup.db');

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => cb(null, 'file-' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use(session({ secret: 'worldcup-secret-key', resave: false, saveUninitialized: true }));

// ==========================================
// 1. สร้างตารางฐานข้อมูล
// ==========================================
db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, avatar TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS matches (id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT, home_team TEXT, away_team TEXT, kickoff_time TEXT, home_score INTEGER, away_score INTEGER, status TEXT DEFAULT 'OPEN', is_published INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS predictions (user_id INTEGER, match_id INTEGER, home_predict INTEGER, away_predict INTEGER, score_earned INTEGER DEFAULT 0, PRIMARY KEY (user_id, match_id));
    CREATE TABLE IF NOT EXISTS scoring_rules (stage_id TEXT PRIMARY KEY, stage_name TEXT, base_score INTEGER DEFAULT 0, bonus_score INTEGER DEFAULT 0, display_order INTEGER);
`);

// เช็คและเพิ่มคอลัมน์ใหม่ หากใช้ฐานข้อมูลเดิม
try { db.exec('ALTER TABLE matches ADD COLUMN is_published INTEGER DEFAULT 0'); } catch (err) {}
try { db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0'); } catch (err) {}

if (db.prepare('SELECT COUNT(*) as count FROM users WHERE username = ?').get('admin').count === 0) {
    db.prepare('INSERT INTO users (username, password, avatar, is_admin) VALUES (?, ?, ?, ?)').run('admin', bcrypt.hashSync('password123', 10), '/uploads/default.png', 1);
}

if (db.prepare('SELECT COUNT(*) as count FROM scoring_rules').get().count === 0) {
    const insertRule = db.prepare('INSERT INTO scoring_rules (stage_id, stage_name, base_score, bonus_score, display_order) VALUES (?, ?, ?, ?, ?)');
    insertRule.run('group', 'รอบแบ่งกลุ่ม', 1, 2, 1); insertRule.run('32', 'รอบ 32 ทีม', 1, 2, 2); insertRule.run('16', 'รอบ 16 ทีม', 2, 3, 3);
    insertRule.run('8', 'รอบ 8 ทีม', 3, 4, 4); insertRule.run('semi', 'รอบ Semi-final', 4, 5, 5); insertRule.run('final', 'รอบ Final', 6, 7, 6);
}

// Middleware สำหรับเช็ค Auth และบังคับเปลี่ยนรหัสผ่าน
function checkAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    
    // หาก user ถูกบังคับเปลี่ยนรหัส และไม่ได้อยู่ที่หน้าเปลี่ยนรหัส ให้เด้งกลับไป
    if (req.session.user.must_change_password && req.path !== '/change-password' && req.path !== '/logout') {
        return res.redirect('/change-password');
    }
    next();
}

// ==========================================
// 2. ROUTING & PAGES (หน้าหลักของ User)
// ==========================================
app.get('/', checkAuth, (req, res) => {
    const user = req.session.user;
    const matches = db.prepare(`SELECT m.*, p.home_predict, p.away_predict, r.stage_name FROM matches m LEFT JOIN predictions p ON m.id = p.match_id AND p.user_id = ? LEFT JOIN scoring_rules r ON m.stage = r.stage_id ORDER BY m.kickoff_time ASC`).all(user.id);
    const currentTime = new Date();
    matches.forEach(m => {
        const kickOff = new Date(m.kickoff_time);
        m.is_locked = currentTime >= new Date(kickOff.getTime() - 5 * 60 * 1000) || m.status !== 'OPEN';
    });
    res.render('index', { user, matches });
});

app.get('/login', (req, res) => res.render('login', { msg: null }));

app.post('/register', upload.single('avatar'), (req, res) => {
    try {
        db.prepare('INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)').run(req.body.username, bcrypt.hashSync(req.body.password, 10), req.file ? '/uploads/' + req.file.filename : '/uploads/default.png');
        res.render('login', { msg: 'สมัครสมาชิกสำเร็จ! กรุณาเข้าสู่ระบบ' });
    } catch (err) { res.render('login', { msg: 'ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว หรือเกิดข้อผิดพลาด' }); }
});

app.post('/login', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username);
    if (user && bcrypt.compareSync(req.body.password, user.password)) { 
        req.session.user = user; 
        if (user.must_change_password) {
            res.redirect('/change-password'); // ไปหน้าเปลี่ยนรหัส
        } else {
            res.redirect('/'); 
        }
    } else {
        res.render('login', { msg: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง!' });
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ระบบบังคับเปลี่ยนรหัสผ่านด้วยตัวเอง
app.get('/change-password', checkAuth, (req, res) => {
    res.render('change-password', { user: req.session.user, msg: null });
});

app.post('/change-password', checkAuth, (req, res) => {
    const { new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) {
        return res.render('change-password', { user: req.session.user, msg: 'รหัสผ่านใหม่ไม่ตรงกัน กรุณาพิมพ์ให้เหมือนกันทั้ง 2 ช่อง' });
    }
    const hashedPass = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?').run(hashedPass, req.session.user.id);
    req.session.user.must_change_password = 0; // อัปเดต session
    res.redirect('/');
});

app.post('/predict', checkAuth, (req, res) => {
    const match = db.prepare('SELECT kickoff_time, status FROM matches WHERE id = ?').get(req.body.match_id);
    if (new Date() >= new Date(new Date(match.kickoff_time).getTime() - 5 * 60 * 1000) || match.status !== 'OPEN') return res.status(400).send('ปิดรับการทายผลแล้ว');
    db.prepare(`INSERT INTO predictions (user_id, match_id, home_predict, away_predict) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, match_id) DO UPDATE SET home_predict = excluded.home_predict, away_predict = excluded.away_predict`).run(req.session.user.id, req.body.match_id, req.body.home_predict, req.body.away_predict);
    res.redirect('/');
});

app.get('/leaderboard', checkAuth, (req, res) => {
    res.render('leaderboard', { user: req.session.user, leaderboard: db.prepare(`SELECT u.username, u.avatar, SUM(p.score_earned) as total_score FROM users u LEFT JOIN predictions p ON u.id = p.user_id GROUP BY u.id ORDER BY total_score DESC`).all() });
});

app.get('/match/:id/predictions', checkAuth, (req, res) => {
    const match = db.prepare('SELECT m.*, r.stage_name FROM matches m LEFT JOIN scoring_rules r ON m.stage = r.stage_id WHERE m.id = ?').get(req.params.id);
    if (!match) return res.status(404).send('ไม่พบแมตช์นี้');
    if (!match.is_published && !req.session.user.is_admin) return res.status(403).send('Admin ยังไม่เปิดเผยผลการทาย');
    const predictions = db.prepare(`SELECT p.home_predict, p.away_predict, p.score_earned, u.username, u.avatar FROM predictions p JOIN users u ON p.user_id = u.id WHERE p.match_id = ? ORDER BY u.username ASC`).all(req.params.id);
    res.render('match-predictions', { user: req.session.user, match, predictions });
});

// ==========================================
// 3. ระบบจัดการ ADMIN
// ==========================================
app.get('/admin', checkAuth, (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    const rules = db.prepare('SELECT * FROM scoring_rules ORDER BY display_order ASC').all();
    const matches = db.prepare('SELECT m.*, r.stage_name FROM matches m LEFT JOIN scoring_rules r ON m.stage = r.stage_id ORDER BY m.kickoff_time ASC').all();
    const totalMatches = matches.length;
    const userStats = db.prepare(`SELECT u.id, u.username, u.avatar, COUNT(p.match_id) as predicted_count FROM users u LEFT JOIN predictions p ON u.id = p.user_id WHERE u.is_admin = 0 GROUP BY u.id`).all();
    
    // ดึงข้อมูล User ทั้งหมด (ยกเว้น Admin เอง)
    const allUsers = db.prepare('SELECT id, username, avatar FROM users WHERE is_admin = 0 ORDER BY username ASC').all();
    
    res.render('admin', { matches, rules, userStats, totalMatches, allUsers });
});

// จัดการผู้ใช้งาน
app.post('/admin/delete-user', checkAuth, (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    const userId = req.body.user_id;
    db.prepare('DELETE FROM users WHERE id = ? AND is_admin = 0').run(userId);
    db.prepare('DELETE FROM predictions WHERE user_id = ?').run(userId);
    res.redirect('/admin');
});

app.post('/admin/reset-password', checkAuth, (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    const userId = req.body.user_id;
    const defaultPass = bcrypt.hashSync('123456', 10); // รหัสเริ่มต้น
    db.prepare('UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?').run(defaultPass, userId);
    res.redirect('/admin');
});

app.post('/admin/update-rules', checkAuth, (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    const updateStmt = db.prepare('UPDATE scoring_rules SET base_score = ?, bonus_score = ? WHERE stage_id = ?');
    db.transaction((rulesData) => { for (const stageId in rulesData) updateStmt.run(parseInt(rulesData[stageId].base_score) || 0, parseInt(rulesData[stageId].bonus_score) || 0, stageId); })(req.body.rules);
    res.redirect('/admin');
});

app.post('/admin/add-match', checkAuth, (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    db.prepare('INSERT INTO matches (stage, home_team, away_team, kickoff_time) VALUES (?, ?, ?, ?)').run(req.body.stage, req.body.home_team, req.body.away_team, req.body.kickoff_time.replace('T', ' '));
    res.redirect('/admin');
});

app.post('/admin/delete-match', checkAuth, (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    db.prepare('DELETE FROM matches WHERE id = ?').run(req.body.match_id); db.prepare('DELETE FROM predictions WHERE match_id = ?').run(req.body.match_id);
    res.redirect('/admin');
});

app.post('/admin/toggle-publish', checkAuth, (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    db.prepare('UPDATE matches SET is_published = ? WHERE id = ?').run(req.body.is_published, req.body.match_id);
    res.redirect('/admin');
});

app.post('/admin/settle', checkAuth, (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    db.prepare("UPDATE matches SET home_score = ?, away_score = ?, status = 'FINISHED' WHERE id = ?").run(req.body.home_score, req.body.away_score, req.body.match_id);
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.body.match_id);
    const rule = db.prepare('SELECT base_score, bonus_score FROM scoring_rules WHERE stage_id = ?').get(match.stage);
    const predictions = db.prepare('SELECT * FROM predictions WHERE match_id = ?').all(req.body.match_id);
    
    const actualResult = match.home_score > match.away_score ? 'HOME' : (match.home_score < match.away_score ? 'AWAY' : 'DRAW');
    for (let p of predictions) {
        let earned = 0;
        const predictResult = p.home_predict > p.away_predict ? 'HOME' : (p.home_predict < p.away_predict ? 'AWAY' : 'DRAW');
        if (predictResult === actualResult) {
            earned += (rule ? rule.base_score : 0);
            if (p.home_predict == match.home_score && p.away_predict == match.away_score) earned += (rule ? rule.bonus_score : 0);
        }
        db.prepare('UPDATE predictions SET score_earned = ? WHERE user_id = ? AND match_id = ?').run(earned, p.user_id, req.body.match_id);
    }
    res.redirect('/admin');
});

app.post('/admin/import-matches', checkAuth, upload.single('csv_file'), (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    if (!req.file) return res.redirect('/admin');
    try {
        const fileContent = fs.readFileSync(req.file.path, 'utf8');
        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
        const insertStmt = db.prepare('INSERT INTO matches (stage, home_team, away_team, kickoff_time) VALUES (?, ?, ?, ?)');
        db.transaction(() => {
            for(let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',');
                if (cols.length >= 4) insertStmt.run(cols[0].trim(), cols[1].trim(), cols[2].trim(), cols[3].trim());
            }
        })();
        fs.unlinkSync(req.file.path); res.redirect('/admin');
    } catch (err) { res.status(500).send('เกิดข้อผิดพลาดในการนำเข้า'); }
});

app.post('/admin/import-predictions', checkAuth, upload.single('csv_file'), (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    if (!req.file) return res.redirect('/admin');
    try {
        const fileContent = fs.readFileSync(req.file.path, 'utf8');
        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
        const getUser = db.prepare('SELECT id FROM users WHERE username = ?');
        const insertStmt = db.prepare(`INSERT INTO predictions (user_id, match_id, home_predict, away_predict) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, match_id) DO UPDATE SET home_predict = excluded.home_predict, away_predict = excluded.away_predict`);
        db.transaction(() => {
            for(let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',');
                if (cols.length >= 4) {
                    const user = getUser.get(cols[0].trim());
                    if (user) insertStmt.run(user.id, parseInt(cols[1].trim()), parseInt(cols[2].trim()), parseInt(cols[3].trim()));
                }
            }
        })();
        fs.unlinkSync(req.file.path); res.redirect('/admin');
    } catch (err) { res.status(500).send('เกิดข้อผิดพลาดในการนำเข้า'); }
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));