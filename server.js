const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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
// 1. สร้างตารางฐานข้อมูล PostgreSQL (รันอัตโนมัติ)
// ==========================================
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(255) UNIQUE, password TEXT, avatar TEXT, is_admin INTEGER DEFAULT 0, must_change_password INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS matches (id SERIAL PRIMARY KEY, stage VARCHAR(50), home_team VARCHAR(100), away_team VARCHAR(100), kickoff_time TIMESTAMP, home_score INTEGER, away_score INTEGER, status VARCHAR(20) DEFAULT 'OPEN', is_published INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS predictions (user_id INTEGER, match_id INTEGER, home_predict INTEGER, away_predict INTEGER, score_earned INTEGER DEFAULT 0, PRIMARY KEY (user_id, match_id));
            CREATE TABLE IF NOT EXISTS scoring_rules (stage_id VARCHAR(50) PRIMARY KEY, stage_name VARCHAR(100), base_score INTEGER DEFAULT 0, bonus_score INTEGER DEFAULT 0, display_order INTEGER);
        `);

        const adminCheck = await pool.query('SELECT COUNT(*) as count FROM users WHERE username = $1', ['admin']);
        if (adminCheck.rows[0].count == 0) {
            await pool.query('INSERT INTO users (username, password, avatar, is_admin) VALUES ($1, $2, $3, $4)', ['admin', bcrypt.hashSync('password123', 10), '/uploads/default.png', 1]);
        }

        const ruleCheck = await pool.query('SELECT COUNT(*) as count FROM scoring_rules');
        if (ruleCheck.rows[0].count == 0) {
            const rules = [['group', 'รอบแบ่งกลุ่ม', 1, 2, 1], ['32', 'รอบ 32 ทีม', 1, 2, 2], ['16', 'รอบ 16 ทีม', 2, 3, 3], ['8', 'รอบ 8 ทีม', 3, 4, 4], ['semi', 'รอบ Semi-final', 4, 5, 5], ['final', 'รอบ Final', 6, 7, 6]];
            for (let r of rules) await pool.query('INSERT INTO scoring_rules (stage_id, stage_name, base_score, bonus_score, display_order) VALUES ($1, $2, $3, $4, $5)', r);
        }
        console.log('✅ PostgreSQL Database Initialized!');
    } catch (err) { console.error('DB Init Error:', err); }
};
initDB();

function checkAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.must_change_password && req.path !== '/change-password' && req.path !== '/logout') return res.redirect('/change-password');
    next();
}

// ==========================================
// 2. ROUTING & PAGES
// ==========================================
app.get('/', checkAuth, async (req, res) => {
    if (req.session.user.is_admin === 1) return res.redirect('/admin');

    // เพิ่ม p.score_earned เข้าไปใน Query
    const { rows: matches } = await pool.query(`SELECT m.*, p.home_predict, p.away_predict, p.score_earned, r.stage_name FROM matches m LEFT JOIN predictions p ON m.id = p.match_id AND p.user_id = $1 LEFT JOIN scoring_rules r ON m.stage = r.stage_id ORDER BY m.kickoff_time ASC`, [req.session.user.id]);
    const currentTime = new Date();
    matches.forEach(m => {
        const kickOff = new Date(m.kickoff_time);
        m.kickoff_time = m.kickoff_time.toISOString().replace('T', ' ').substring(0, 16); 
        m.is_locked = currentTime >= new Date(kickOff.getTime() - 5 * 60 * 1000) || m.status !== 'OPEN';
    });
    res.render('index', { user: req.session.user, matches });
});

app.get('/login', (req, res) => res.render('login', { msg: null }));
app.post('/register', upload.single('avatar'), async (req, res) => {
    try {
        await pool.query('INSERT INTO users (username, password, avatar) VALUES ($1, $2, $3)', [req.body.username, bcrypt.hashSync(req.body.password, 10), req.file ? '/uploads/' + req.file.filename : '/uploads/default.png']);
        res.render('login', { msg: 'สมัครสมาชิกสำเร็จ! กรุณาเข้าสู่ระบบ' });
    } catch (err) { res.render('login', { msg: 'ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว หรือเกิดข้อผิดพลาด' }); }
});

app.post('/login', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [req.body.username]);
    if (rows.length > 0 && bcrypt.compareSync(req.body.password, rows[0].password)) { 
        req.session.user = rows[0]; 
        if (rows[0].must_change_password) res.redirect('/change-password'); 
        else if (rows[0].is_admin === 1) res.redirect('/admin'); 
        else res.redirect('/'); 
    } else { res.render('login', { msg: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง!' }); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/change-password', checkAuth, (req, res) => res.render('change-password', { user: req.session.user, msg: null }));
app.post('/change-password', checkAuth, async (req, res) => {
    if (req.body.new_password !== req.body.confirm_password) return res.render('change-password', { user: req.session.user, msg: 'รหัสผ่านใหม่ไม่ตรงกัน' });
    await pool.query('UPDATE users SET password = $1, must_change_password = 0 WHERE id = $2', [bcrypt.hashSync(req.body.new_password, 10), req.session.user.id]);
    req.session.user.must_change_password = 0;
    res.redirect('/');
});

app.post('/predict', checkAuth, async (req, res) => {
    if (req.session.user.is_admin === 1) return res.status(403).send('ผู้ดูแลระบบไม่มีสิทธิ์บันทึกข้อมูลผลการทาย');
    const { rows: match } = await pool.query('SELECT kickoff_time, status FROM matches WHERE id = $1', [req.body.match_id]);
    if (new Date() >= new Date(new Date(match[0].kickoff_time).getTime() - 5 * 60 * 1000) || match[0].status !== 'OPEN') return res.status(400).send('ปิดรับการทายผลแล้ว');
    await pool.query(`INSERT INTO predictions (user_id, match_id, home_predict, away_predict) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id, match_id) DO UPDATE SET home_predict = EXCLUDED.home_predict, away_predict = EXCLUDED.away_predict`, [req.session.user.id, req.body.match_id, req.body.home_predict, req.body.away_predict]);
    res.redirect('/');
});

app.get('/leaderboard', checkAuth, async (req, res) => {
    // ดึง u.id ออกมาด้วยเพื่อใช้ทำลิงก์
    const { rows: leaderboard } = await pool.query(`SELECT u.id, u.username, u.avatar, COALESCE(SUM(p.score_earned), 0) as total_score FROM users u LEFT JOIN predictions p ON u.id = p.user_id WHERE u.is_admin = 0 GROUP BY u.id, u.username, u.avatar ORDER BY total_score DESC`);
    res.render('leaderboard', { user: req.session.user, leaderboard });
});

// ฟีเจอร์ใหม่: ดูหน้าทายผลของเพื่อนแต่ละคน
app.get('/user/:id/predictions', checkAuth, async (req, res) => {
    const { rows: targetUser } = await pool.query('SELECT id, username, avatar FROM users WHERE id = $1 AND is_admin = 0', [req.params.id]);
    if (targetUser.length === 0) return res.status(404).send('ไม่พบผู้ใช้งานนี้');

    const { rows: matches } = await pool.query(`SELECT m.*, p.home_predict, p.away_predict, p.score_earned, r.stage_name FROM matches m LEFT JOIN predictions p ON m.id = p.match_id AND p.user_id = $1 LEFT JOIN scoring_rules r ON m.stage = r.stage_id ORDER BY m.kickoff_time ASC`, [req.params.id]);
    const currentTime = new Date();
    
    matches.forEach(m => {
        const kickOff = new Date(m.kickoff_time);
        m.is_locked = currentTime >= new Date(kickOff.getTime() - 5 * 60 * 1000) || m.status !== 'OPEN';
        m.kickoff_time = m.kickoff_time.toISOString().replace('T', ' ').substring(0, 16); 
        
        // ซ่อนคำทายของเพื่อนหากแมตช์ยังไม่ถูกล็อค (ป้องกันการลอกข้อสอบ)
        if (!m.is_locked && !m.is_published) {
            m.home_predict = null;
            m.away_predict = null;
            m.is_hidden = true;
        }
    });

    res.render('user-predictions', { user: req.session.user, targetUser: targetUser[0], matches });
});

app.get('/match/:id/predictions', checkAuth, async (req, res) => {
    const { rows: matchInfo } = await pool.query('SELECT m.*, r.stage_name FROM matches m LEFT JOIN scoring_rules r ON m.stage = r.stage_id WHERE m.id = $1', [req.params.id]);
    if (matchInfo.length === 0) return res.status(404).send('ไม่พบแมตช์นี้');
    if (!matchInfo[0].is_published && !req.session.user.is_admin) return res.status(403).send('Admin ยังไม่เปิดเผยผลการทาย');
    const { rows: predictions } = await pool.query(`SELECT p.home_predict, p.away_predict, p.score_earned, u.username, u.avatar FROM predictions p JOIN users u ON p.user_id = u.id WHERE p.match_id = $1 ORDER BY u.username ASC`, [req.params.id]);
    res.render('match-predictions', { user: req.session.user, match: matchInfo[0], predictions });
});

// ==========================================
// 3. ระบบจัดการ ADMIN
// ==========================================
app.get('/admin', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    const { rows: rules } = await pool.query('SELECT * FROM scoring_rules ORDER BY display_order ASC');
    const { rows: matches } = await pool.query('SELECT m.*, r.stage_name FROM matches m LEFT JOIN scoring_rules r ON m.stage = r.stage_id ORDER BY m.kickoff_time ASC');
    matches.forEach(m => m.kickoff_time = m.kickoff_time.toISOString().replace('T', ' ').substring(0, 16));
    const { rows: userStats } = await pool.query(`SELECT u.id, u.username, u.avatar, COUNT(p.match_id) as predicted_count FROM users u LEFT JOIN predictions p ON u.id = p.user_id WHERE u.is_admin = 0 GROUP BY u.id, u.username, u.avatar`);
    const { rows: allUsers } = await pool.query('SELECT id, username, avatar FROM users WHERE is_admin = 0 ORDER BY username ASC');
    
    // [แก้ไขเพิ่มเติม] ส่งข้อมูล user: req.session.user เข้าไปด้วยเพื่อนำข้อมูลโปรไฟล์และปุ่มเมนูแอดมินไปแสดงผลบนหน้าจอ
    res.render('admin', { user: req.session.user, matches, rules, userStats, totalMatches: matches.length, allUsers });
});

app.post('/admin/delete-user', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('DELETE FROM users WHERE id = $1 AND is_admin = 0', [req.body.user_id]);
    await pool.query('DELETE FROM predictions WHERE user_id = $1', [req.body.user_id]);
    res.redirect('/admin');
});

app.post('/admin/reset-password', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('UPDATE users SET password = $1, must_change_password = 1 WHERE id = $2', [bcrypt.hashSync('123456', 10), req.body.user_id]);
    res.redirect('/admin');
});

app.post('/admin/update-rules', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    for (const stageId in req.body.rules) {
        await pool.query('UPDATE scoring_rules SET base_score = $1, bonus_score = $2 WHERE stage_id = $3', [parseInt(req.body.rules[stageId].base_score) || 0, parseInt(req.body.rules[stageId].bonus_score) || 0, stageId]);
    }
    res.redirect('/admin');
});

app.post('/admin/add-match', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('INSERT INTO matches (stage, home_team, away_team, kickoff_time) VALUES ($1, $2, $3, $4)', [req.body.stage, req.body.home_team, req.body.away_team, req.body.kickoff_time.replace('T', ' ')]);
    res.redirect('/admin');
});

app.post('/admin/delete-match', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('DELETE FROM matches WHERE id = $1', [req.body.match_id]);
    await pool.query('DELETE FROM predictions WHERE match_id = $1', [req.body.match_id]);
    res.redirect('/admin');
});

app.post('/admin/toggle-publish', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('UPDATE matches SET is_published = $1 WHERE id = $2', [req.body.is_published, req.body.match_id]);
    res.redirect('/admin');
});

app.post('/admin/settle', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');

    // 1. แปลงค่าคะแนนให้เป็นตัวเลขเสมอ
    const matchId = parseInt(req.body.match_id);
    const actualHome = parseInt(req.body.home_score);
    const actualAway = parseInt(req.body.away_score);

    // 2. อัปเดตผลสกอร์จริงลงตารางการแข่งขัน
    await pool.query("UPDATE matches SET home_score = $1, away_score = $2, status = 'FINISHED' WHERE id = $3", [actualHome, actualAway, matchId]);

    // 3. ดึงข้อมูลแมตช์ และหากฎคะแนนแบบยืดหยุ่น (ค้นหาจากทั้ง id และ name)
    const { rows: match } = await pool.query('SELECT * FROM matches WHERE id = $1', [matchId]);
    const stageRaw = match[0].stage ? match[0].stage.trim() : '';
    
    const { rows: rule } = await pool.query('SELECT base_score, bonus_score FROM scoring_rules WHERE stage_id = $1 OR stage_name = $1', [stageRaw]);

    // กันเหนียว! ถ้าระบบหากฎคะแนนไม่เจอจริงๆ ให้ใช้ค่า Default: ทายถูก=1, สกอร์เป๊ะ=2
    const baseScore = rule.length > 0 ? parseInt(rule[0].base_score) : 1;
    const bonusScore = rule.length > 0 ? parseInt(rule[0].bonus_score) : 2;

    console.log(`\n👉 [DEBUG] แมตช์ #${matchId} | รอบ: ${stageRaw} | แจกแต้มพื้นฐาน: ${baseScore} | โบนัส: ${bonusScore}`);

    // 4. เริ่มคำนวณหาว่าใครชนะ
    const actualResult = actualHome > actualAway ? 'HOME' : (actualHome < actualAway ? 'AWAY' : 'DRAW');
    
    // 5. ดึงคำทายของทุกคนมาตรวจ
    const { rows: predictions } = await pool.query('SELECT * FROM predictions WHERE match_id = $1', [matchId]);

    for (let p of predictions) {
        let earned = 0;
        
        // เช็คว่าผู้เล่นกรอกตัวเลขทายผลมาครบถ้วน
        if (p.home_predict !== null && p.away_predict !== null) {
            const predHome = parseInt(p.home_predict);
            const predAway = parseInt(p.away_predict);
            const predictResult = predHome > predAway ? 'HOME' : (predHome < predAway ? 'AWAY' : 'DRAW');

            // เงื่อนไขที่ 1: ทายทิศทาง (ชนะ/แพ้/เสมอ) ถูกต้อง
            if (predictResult === actualResult) {
                earned += baseScore; 
                
                // เงื่อนไขที่ 2: ทายสกอร์เป๊ะเวอร์!
                if (predHome === actualHome && predAway === actualAway) {
                    earned += bonusScore; 
                }
            }
            console.log(`- ผู้เล่น ID: ${p.user_id} | ทาย: ${predHome}:${predAway} | ควรได้แต้ม: ${earned}`);
        }
        
        // 6. อัปเดตคะแนนที่ได้ลงฐานข้อมูล
        await pool.query('UPDATE predictions SET score_earned = $1 WHERE user_id = $2 AND match_id = $3', [earned, p.user_id, matchId]);
    }

    res.redirect('/admin');
});

app.post('/admin/import-matches', checkAuth, upload.single('csv_file'), async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    if (!req.file) return res.redirect('/admin');
    try {
        const fileContent = fs.readFileSync(req.file.path, 'utf8');
        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length >= 4) await pool.query('INSERT INTO matches (stage, home_team, away_team, kickoff_time) VALUES ($1, $2, $3, $4)', [cols[0].trim(), cols[1].trim(), cols[2].trim(), cols[3].trim()]);
        }
        fs.unlinkSync(req.file.path); res.redirect('/admin');
    } catch (err) { res.status(500).send('เกิดข้อผิดพลาดในการนำเข้า'); }
});

app.post('/admin/import-predictions', checkAuth, upload.single('csv_file'), async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    if (!req.file) return res.redirect('/admin');
    try {
        const fileContent = fs.readFileSync(req.file.path, 'utf8');
        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length >= 4) {
                const { rows: user } = await pool.query('SELECT id FROM users WHERE username = $1', [cols[0].trim()]);
                if (user.length > 0) {
                    await pool.query(`INSERT INTO predictions (user_id, match_id, home_predict, away_predict) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id, match_id) DO UPDATE SET home_predict = EXCLUDED.home_predict, away_predict = EXCLUDED.away_predict`, [user[0].id, parseInt(cols[1].trim()), parseInt(cols[2].trim()), parseInt(cols[3].trim())]);
                }
            }
        }
        fs.unlinkSync(req.file.path); res.redirect('/admin');
    } catch (err) { res.status(500).send('เกิดข้อผิดพลาดในการนำเข้า'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));