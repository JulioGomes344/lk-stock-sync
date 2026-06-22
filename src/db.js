import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// No Railway, aponte DB_PATH para o Volume montado (ex: /data/lk.db)
// para o banco sobreviver a deploys.
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'lk-compras.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;
