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

const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } 
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: 'worldcup-secret-key', resave: false, saveUninitialized: true }));

const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(255) UNIQUE, password TEXT, avatar TEXT, is_admin INTEGER DEFAULT 0, must_change_password INTEGER DEFAULT 0, is_hidden INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS matches (id SERIAL PRIMARY KEY, stage VARCHAR(50), home_team VARCHAR(100), away_team VARCHAR(100), kickoff_time TIMESTAMP, home_score INTEGER, away_score INTEGER, status VARCHAR(20) DEFAULT 'OPEN', is_published INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS predictions (user_id INTEGER, match_id INTEGER, home_predict INTEGER, away_predict INTEGER, score_earned INTEGER DEFAULT 0, PRIMARY KEY (user_id, match_id));
            CREATE TABLE IF NOT EXISTS scoring_rules (stage_id VARCHAR(50) PRIMARY KEY, stage_name VARCHAR(100), base_score INTEGER DEFAULT 0, bonus_score INTEGER DEFAULT 0, display_order INTEGER);
            CREATE TABLE IF NOT EXISTS rewards (id SERIAL PRIMARY KEY, rank INTEGER, description TEXT, icon TEXT, color VARCHAR(20) DEFAULT '#ffffff');
        `);

        try { await pool.query('ALTER TABLE users ADD COLUMN is_hidden INTEGER DEFAULT 0;'); } catch (e) {}
        try { await pool.query('ALTER TABLE rewards ADD COLUMN color VARCHAR(20) DEFAULT \'#ffffff\';'); } catch (e) {}

        const adminCheck = await pool.query('SELECT COUNT(*) as count FROM users WHERE username = $1', ['admin']);
        if (adminCheck.rows[0].count == 0) {
            const defaultAdminAvatar = 'https://ui-avatars.com/api/?name=Admin&background=0D8ABC&color=fff&size=150';
            await pool.query('INSERT INTO users (username, password, avatar, is_admin) VALUES ($1, $2, $3, $4)', ['admin', bcrypt.hashSync('password123', 10), defaultAdminAvatar, 1]);
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

const getThaiTime = () => {
    const date = new Date();
    const thaiTimeStr = date.toLocaleString("en-US", {timeZone: "Asia/Bangkok"});
    return new Date(thaiTimeStr);
};

app.get('/', checkAuth, async (req, res) => {
    if (req.session.user.is_admin === 1) return res.redirect('/admin');
    const { rows: matches } = await pool.query(`SELECT m.*, p.home_predict, p.away_predict, p.score_earned, r.stage_name FROM matches m LEFT JOIN predictions p ON m.id = p.match_id AND p.user_id = $1 LEFT JOIN scoring_rules r ON m.stage = r.stage_id ORDER BY m.kickoff_time ASC`, [req.session.user.id]);
    const currentTime = getThaiTime(); 
    matches.forEach(m => {
        const kickOff = new Date(m.kickoff_time);
        // เพิ่มเงื่อนไข: หาก is_published เป็น 1 จะถูกล็อกอัตโนมัติ
        m.is_locked = currentTime >= kickOff || m.status !== 'OPEN' || m.is_published === 1;
        m.kickoff_time = m.kickoff_time.toISOString().replace('T', ' ').substring(0, 16); 
    });
    res.render('index', { user: req.session.user, matches });
});

app.get('/login', (req, res) => res.render('login', { msg: null }));

app.post('/register', upload.single('avatar'), async (req, res) => {
    try {
        let avatarData = `https://ui-avatars.com/api/?name=${encodeURIComponent(req.body.username)}&background=random&size=150`; 
        if (req.file) {
            const base64Image = req.file.buffer.toString('base64');
            const mimeType = req.file.mimetype;
            avatarData = `data:${mimeType};base64,${base64Image}`;
        }
        await pool.query('INSERT INTO users (username, password, avatar) VALUES ($1, $2, $3)', [req.body.username, bcrypt.hashSync(req.body.password, 10), avatarData]);
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

app.post('/update-avatar', checkAuth, upload.single('avatar'), async (req, res) => {
    if (req.file) {
        const base64Image = req.file.buffer.toString('base64');
        const mimeType = req.file.mimetype;
        const avatarData = `data:${mimeType};base64,${base64Image}`;
        await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarData, req.session.user.id]);
        req.session.user.avatar = avatarData; 
    }
    res.redirect('/');
});

app.get('/change-password', checkAuth, (req, res) => res.render('change-password', { user: req.session.user, msg: null }));
app.post('/change-password', checkAuth, async (req, res) => {
    if (req.body.new_password !== req.body.confirm_password) return res.render('change-password', { user: req.session.user, msg: 'รหัสผ่านใหม่ไม่ตรงกัน' });
    await pool.query('UPDATE users SET password = $1, must_change_password = 0 WHERE id = $2', [bcrypt.hashSync(req.body.new_password, 10), req.session.user.id]);
    req.session.user.must_change_password = 0;
    res.redirect('/');
});

app.post('/predict', checkAuth, async (req, res) => {
    if (req.session.user.is_admin === 1) return res.status(403).send('ผู้ดูแลระบบไม่มีสิทธิ์บันทึกข้อมูลผลการทาย');
    
    // ตรวจสอบทั้งเวลา และ สถานะการตีพิมพ์ (เปิดโพย)
    const { rows: match } = await pool.query('SELECT kickoff_time, status, is_published FROM matches WHERE id = $1', [req.body.match_id]);
    const kickOff = new Date(match[0].kickoff_time);
    const currentTime = getThaiTime(); 
    
    if (currentTime >= kickOff || match[0].status !== 'OPEN' || match[0].is_published === 1) {
        return res.status(400).send('ระบบปิดรับการทายผลแล้ว (แอดมินเปิดโพย หรือแมตช์ถูกล็อกแล้ว)');
    }
    
    await pool.query(`INSERT INTO predictions (user_id, match_id, home_predict, away_predict) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id, match_id) DO UPDATE SET home_predict = EXCLUDED.home_predict, away_predict = EXCLUDED.away_predict`, [req.session.user.id, req.body.match_id, req.body.home_predict, req.body.away_predict]);
    
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json({ success: true });
    }
    res.redirect('/');
});

app.get('/leaderboard', checkAuth, async (req, res) => {
    const query = `
        SELECT u.id, u.username, u.avatar,
            COALESCE(SUM(CASE WHEN m.status = 'FINISHED' AND p.match_id IS NOT NULL THEN 1 ELSE 0 END), 0) as mp,
            COALESCE(SUM(CASE WHEN m.status = 'FINISHED' AND ((p.home_predict > p.away_predict AND m.home_score > m.away_score) OR (p.home_predict < p.away_predict AND m.home_score < m.away_score) OR (p.home_predict = p.away_predict AND m.home_score = m.away_score)) THEN 1 ELSE 0 END), 0) as correct_result_count,
            COALESCE(SUM(CASE WHEN m.status = 'FINISHED' AND ((p.home_predict > p.away_predict AND m.home_score > m.away_score) OR (p.home_predict < p.away_predict AND m.home_score < m.away_score) OR (p.home_predict = p.away_predict AND m.home_score = m.away_score)) THEN COALESCE(r.base_score, 1) ELSE 0 END), 0) as correct_result_score,
            COALESCE(SUM(CASE WHEN m.status = 'FINISHED' AND p.home_predict = m.home_score AND p.away_predict = m.away_score THEN 1 ELSE 0 END), 0) as exact_score_count,
            COALESCE(SUM(CASE WHEN m.status = 'FINISHED' AND p.home_predict = m.home_score AND p.away_predict = m.away_score THEN COALESCE(r.bonus_score, 2) ELSE 0 END), 0) as exact_score_score,
            COALESCE(SUM(p.score_earned), 0) as total_score
        FROM users u 
        LEFT JOIN predictions p ON u.id = p.user_id 
        LEFT JOIN matches m ON p.match_id = m.id
        LEFT JOIN scoring_rules r ON LOWER(TRIM(m.stage)) = LOWER(TRIM(r.stage_id)) OR LOWER(TRIM(m.stage)) = LOWER(TRIM(r.stage_name))
        WHERE u.is_admin = 0 AND u.is_hidden = 0
        GROUP BY u.id, u.username, u.avatar 
        ORDER BY total_score DESC, exact_score_score DESC, u.username ASC
    `;
    const { rows: leaderboard } = await pool.query(query);
    const { rows: rewards } = await pool.query('SELECT * FROM rewards ORDER BY rank ASC');
    res.render('leaderboard', { user: req.session.user, leaderboard, rewards });
});

app.get('/leaderboard/detailed', checkAuth, async (req, res) => {
    const userQuery = `
        SELECT u.id, u.username, u.avatar, 
               COALESCE(SUM(p.score_earned), 0) as total_score,
               COALESCE(SUM(CASE WHEN m.status = 'FINISHED' AND p.home_predict = m.home_score AND p.away_predict = m.away_score THEN COALESCE(r.bonus_score, 2) ELSE 0 END), 0) as exact_score_score
        FROM users u 
        LEFT JOIN predictions p ON u.id = p.user_id 
        LEFT JOIN matches m ON p.match_id = m.id AND m.status = 'FINISHED'
        LEFT JOIN scoring_rules r ON LOWER(TRIM(m.stage)) = LOWER(TRIM(r.stage_id)) OR LOWER(TRIM(m.stage)) = LOWER(TRIM(r.stage_name))
        WHERE u.is_admin = 0 AND u.is_hidden = 0 
        GROUP BY u.id, u.username, u.avatar 
        ORDER BY total_score DESC, exact_score_score DESC, u.username ASC
    `;
    const { rows: users } = await pool.query(userQuery);
    const matchQuery = `SELECT m.id, m.home_team, m.away_team, m.home_score, m.away_score, m.kickoff_time, r.stage_name FROM matches m LEFT JOIN scoring_rules r ON LOWER(TRIM(m.stage)) = LOWER(TRIM(r.stage_id)) OR LOWER(TRIM(m.stage)) = LOWER(TRIM(r.stage_name)) WHERE m.status = 'FINISHED' ORDER BY m.kickoff_time DESC`;
    const { rows: matches } = await pool.query(matchQuery);
    const { rows: predictions } = await pool.query(`SELECT p.user_id, p.match_id, p.home_predict, p.away_predict, p.score_earned FROM predictions p JOIN matches m ON p.match_id = m.id WHERE m.status = 'FINISHED'`);
    const predMap = {};
    predictions.forEach(p => { if (!predMap[p.match_id]) predMap[p.match_id] = {}; predMap[p.match_id][p.user_id] = p; });
    res.render('leaderboard-detailed', { user: req.session.user, users, matches, predMap });
});

app.get('/user/:id/predictions', checkAuth, async (req, res) => {
    const { rows: targetUser } = await pool.query('SELECT id, username, avatar FROM users WHERE id = $1 AND is_admin = 0', [req.params.id]);
    if (targetUser.length === 0) return res.status(404).send('ไม่พบผู้ใช้งานนี้');
    const { rows: matches } = await pool.query(`SELECT m.*, p.home_predict, p.away_predict, p.score_earned, r.stage_name FROM matches m LEFT JOIN predictions p ON m.id = p.match_id AND p.user_id = $1 LEFT JOIN scoring_rules r ON m.stage = r.stage_id ORDER BY m.kickoff_time ASC`, [req.params.id]);
    const currentTime = getThaiTime(); 
    matches.forEach(m => {
        const kickOff = new Date(m.kickoff_time);
        m.is_locked = currentTime >= kickOff || m.status !== 'OPEN' || m.is_published === 1;
        m.kickoff_time = m.kickoff_time.toISOString().replace('T', ' ').substring(0, 16); 
        if (!m.is_locked && !m.is_published) { m.home_predict = null; m.away_predict = null; m.is_hidden = true; }
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
    
    const thaiTime = getThaiTime();
    let startMatchDay = new Date(thaiTime);
    startMatchDay.setHours(12, 0, 0, 0);
    if (thaiTime.getHours() < 12) { startMatchDay.setDate(startMatchDay.getDate() - 1); }
    let endMatchDay = new Date(startMatchDay);
    endMatchDay.setDate(endMatchDay.getDate() + 1);

    const pad = n => n.toString().padStart(2, '0');
    const startStr = `${startMatchDay.getFullYear()}-${pad(startMatchDay.getMonth()+1)}-${pad(startMatchDay.getDate())} 12:00:00`;
    const endStr = `${endMatchDay.getFullYear()}-${pad(endMatchDay.getMonth()+1)}-${pad(endMatchDay.getDate())} 12:00:00`;
    const matchDayText = `${pad(startMatchDay.getDate())}/${pad(startMatchDay.getMonth()+1)} เวลา 12:00 น. ถึง ${pad(endMatchDay.getDate())}/${pad(endMatchDay.getMonth()+1)} เวลา 12:00 น.`;

    const { rows: activeMatchResult } = await pool.query('SELECT COUNT(*) as count FROM matches WHERE kickoff_time >= $1 AND kickoff_time < $2', [startStr, endStr]);
    const activeTotalMatches = parseInt(activeMatchResult[0].count);

    const { rows: userStats } = await pool.query(`
        SELECT u.id, u.username, u.avatar, 
               (SELECT COUNT(*) FROM predictions p JOIN matches m ON p.match_id = m.id WHERE p.user_id = u.id AND m.kickoff_time >= $1 AND m.kickoff_time < $2) as predicted_count 
        FROM users u WHERE u.is_admin = 0
    `, [startStr, endStr]);

    const { rows: allUsers } = await pool.query('SELECT id, username, avatar, is_hidden FROM users WHERE is_admin = 0 ORDER BY username ASC');
    const { rows: rewards } = await pool.query('SELECT * FROM rewards ORDER BY rank ASC');
    
    res.render('admin', { user: req.session.user, matches, rules, userStats, activeTotalMatches, matchDayText, allUsers, rewards });
});

app.post('/admin/toggle-visibility', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('UPDATE users SET is_hidden = $1 WHERE id = $2', [req.body.is_hidden, req.body.user_id]);
    res.redirect('/admin');
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

// เปิดให้ส่งผ่าน AJAX และทำการตรวจสอบว่าทายผลครบไหม
app.post('/admin/toggle-publish', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    
    const matchId = parseInt(req.body.match_id);
    const isPublished = parseInt(req.body.is_published);
    const force = req.body.force;

    // หากพยายามเปิดโพย และไม่ได้กดบังคับข้าม
    if (isPublished === 1 && force !== 'true') {
        const { rows: users } = await pool.query('SELECT COUNT(*) as count FROM users WHERE is_admin = 0 AND is_hidden = 0');
        const totalUsers = parseInt(users[0].count);

        const { rows: preds } = await pool.query('SELECT COUNT(*) as count FROM predictions p JOIN users u ON p.user_id = u.id WHERE p.match_id = $1 AND u.is_admin = 0 AND u.is_hidden = 0', [matchId]);
        const totalPreds = parseInt(preds[0].count);

        // ตรวจพบคนทายไม่ครบ แจ้งเตือนกลับไปหา Admin
        if (totalPreds < totalUsers) {
            if (req.headers.accept && req.headers.accept.includes('application/json')) {
                return res.json({ 
                    warning: true, 
                    message: `⚠️ ยังมีผู้เล่นทายผลไม่ครบ (${totalPreds}/${totalUsers} คน)\n\nหากเปิดโพย ระบบจะ "ล็อกผลการทาย" ของแมตช์นี้ทันที!\nยืนยันที่จะเปิดให้ดูโพยเลยหรือไม่?` 
                });
            }
        }
    }

    // บันทึกสถานะการตีพิมพ์
    await pool.query('UPDATE matches SET is_published = $1 WHERE id = $2', [isPublished, matchId]);
    
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json({ success: true, is_published: isPublished });
    }
    res.redirect('/admin');
});

app.post('/admin/settle', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    const matchId = parseInt(req.body.match_id);
    const actualHome = parseInt(req.body.home_score);
    const actualAway = parseInt(req.body.away_score);
    await pool.query("UPDATE matches SET home_score = $1, away_score = $2, status = 'FINISHED' WHERE id = $3", [actualHome, actualAway, matchId]);
    
    const { rows: match } = await pool.query('SELECT * FROM matches WHERE id = $1', [matchId]);
    const stageRaw = match[0].stage ? match[0].stage.trim() : '';
    const { rows: rule } = await pool.query('SELECT base_score, bonus_score FROM scoring_rules WHERE LOWER(TRIM(stage_id)) = LOWER($1) OR LOWER(TRIM(stage_name)) = LOWER($1)', [stageRaw]);
    
    const baseScore = rule.length > 0 ? parseInt(rule[0].base_score) : 1;
    const bonusScore = rule.length > 0 ? parseInt(rule[0].bonus_score) : 2;
    const actualResult = actualHome > actualAway ? 'HOME' : (actualHome < actualAway ? 'AWAY' : 'DRAW');
    
    const { rows: predictions } = await pool.query('SELECT * FROM predictions WHERE match_id = $1', [matchId]);
    for (let p of predictions) {
        let earned = 0;
        if (p.home_predict !== null && p.away_predict !== null) {
            const predHome = parseInt(p.home_predict);
            const predAway = parseInt(p.away_predict);
            const predictResult = predHome > predAway ? 'HOME' : (predHome < predAway ? 'AWAY' : 'DRAW');
            if (predictResult === actualResult) {
                earned += baseScore; 
                if (predHome === actualHome && predAway === actualAway) earned += bonusScore; 
            }
        }
        await pool.query('UPDATE predictions SET score_earned = $1 WHERE user_id = $2 AND match_id = $3', [earned, p.user_id, matchId]);
    }
    
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json({ success: true, home_score: actualHome, away_score: actualAway });
    }
    res.redirect('/admin');
});

app.post('/admin/recalculate-all', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    try {
        const { rows: finishedMatches } = await pool.query("SELECT * FROM matches WHERE status = 'FINISHED'");
        const { rows: rules } = await pool.query("SELECT * FROM scoring_rules");
        for (let match of finishedMatches) {
            const stageRaw = match.stage ? match.stage.trim().toLowerCase() : '';
            const rule = rules.find(r => r.stage_id.toLowerCase() === stageRaw || r.stage_name.toLowerCase() === stageRaw);
            const baseScore = rule ? parseInt(rule.base_score) : 1;
            const bonusScore = rule ? parseInt(rule.bonus_score) : 2;
            const actualHome = parseInt(match.home_score);
            const actualAway = parseInt(match.away_score);
            const actualResult = actualHome > actualAway ? 'HOME' : (actualHome < actualAway ? 'AWAY' : 'DRAW');
            const { rows: predictions } = await pool.query('SELECT * FROM predictions WHERE match_id = $1', [match.id]);
            for (let p of predictions) {
                let earned = 0;
                if (p.home_predict !== null && p.away_predict !== null) {
                    const predHome = parseInt(p.home_predict);
                    const predAway = parseInt(p.away_predict);
                    const predictResult = predHome > predAway ? 'HOME' : (predHome < predAway ? 'AWAY' : 'DRAW');
                    if (predictResult === actualResult) {
                        earned += baseScore; 
                        if (predHome === actualHome && predAway === actualAway) earned += bonusScore; 
                    }
                }
                await pool.query('UPDATE predictions SET score_earned = $1 WHERE user_id = $2 AND match_id = $3', [earned, p.user_id, match.id]);
            }
        }
        res.redirect('/admin');
    } catch (err) { res.status(500).send('เกิดข้อผิดพลาดในการคำนวณคะแนนใหม่'); }
});

app.post('/admin/add-reward', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('INSERT INTO rewards (rank, description, icon, color) VALUES ($1, $2, $3, $4)', [parseInt(req.body.rank), req.body.description, req.body.icon, req.body.color || '#ffffff']);
    res.redirect('/admin');
});

app.post('/admin/edit-reward', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('UPDATE rewards SET rank = $1, description = $2, icon = $3, color = $4 WHERE id = $5', [parseInt(req.body.rank), req.body.description, req.body.icon, req.body.color || '#ffffff', req.body.reward_id]);
    res.redirect('/admin');
});

app.post('/admin/delete-reward', checkAuth, async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    await pool.query('DELETE FROM rewards WHERE id = $1', [req.body.reward_id]);
    res.redirect('/admin');
});

app.post('/admin/import-matches', checkAuth, upload.single('csv_file'), async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    if (!req.file) return res.redirect('/admin');
    try {
        const fileContent = req.file.buffer.toString('utf8');
        const lines = fileContent.split(/\r?\n/).filter(line => line.trim() !== '');
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length >= 4) await pool.query('INSERT INTO matches (stage, home_team, away_team, kickoff_time) VALUES ($1, $2, $3, $4)', [cols[0].trim(), cols[1].trim(), cols[2].trim(), cols[3].trim()]);
        }
        res.redirect('/admin');
    } catch (err) { res.status(500).send('เกิดข้อผิดพลาดในการนำเข้า'); }
});

app.post('/admin/import-predictions', checkAuth, upload.single('csv_file'), async (req, res) => {
    if (!req.session.user.is_admin) return res.status(403).send('Unauthorized');
    if (!req.file) return res.redirect('/admin');
    try {
        const fileContent = req.file.buffer.toString('utf8');
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
        res.redirect('/admin');
    } catch (err) { res.status(500).send('เกิดข้อผิดพลาดในการนำเข้า'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));