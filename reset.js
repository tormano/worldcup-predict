const Database = require('better-sqlite3');
const db = new Database('worldcup.db');

try {
    // 1. ลบข้อมูลในตารางแมตช์และการทายผลทั้งหมดทิ้ง
    db.exec('DELETE FROM matches;');
    db.exec('DELETE FROM predictions;');

    // 2. รีเซ็ตตัวนับ Index (Auto Increment) ของ SQLite ให้กลับไปเป็น 0 (ตัวต่อไปจะเริ่มที่ 1)
    db.exec("DELETE FROM sqlite_sequence WHERE name='matches';");

    console.log('✅ Cleansing ข้อมูลตารางการแข่งขันและการทายผลเรียบร้อยแล้ว!');
    console.log('✅ Index ID ถูกรีเซ็ตให้กลับมาเริ่มที่ 1 ใหม่แล้วครับ');
} catch (err) {
    console.error('❌ เกิดข้อผิดพลาด:', err.message);
}