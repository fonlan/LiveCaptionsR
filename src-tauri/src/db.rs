use rusqlite::Connection;
use std::path::PathBuf;
pub fn get_db_path() -> anyhow::Result<PathBuf> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?
        .join("LiveCaptionsR");

    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)?;
    }

    Ok(config_dir.join("data.db"))
}

pub fn get_connection() -> anyhow::Result<Connection> {
    let path = get_db_path()?;
    let conn = Connection::open(path)?;
    conn.execute("PRAGMA foreign_keys = ON", [])?;
    Ok(conn)
}

pub fn init() -> anyhow::Result<()> {
    let mut conn = get_connection()?;

    let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if current_version < 1 {
        let tx = conn.transaction()?;

        // Sessions table
        tx.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )",
            [],
        )?;

        // Cards table
        tx.execute(
            "CREATE TABLE IF NOT EXISTS session_cards (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                original TEXT NOT NULL,
                translated TEXT,
                status TEXT,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // Index for performance
        tx.execute(
            "CREATE INDEX IF NOT EXISTS idx_session_cards_session_id ON session_cards(session_id)",
            [],
        )?;

        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
    }

    let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current_version < 2 {
        let tx = conn.transaction()?;
        // Add user column to session_cards
        tx.execute("ALTER TABLE session_cards ADD COLUMN user TEXT", [])?;
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
    }

    let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current_version < 3 {
        let tx = conn.transaction()?;
        // Accelerates startup session list preview query ordered by first timestamp.
        tx.execute(
            "CREATE INDEX IF NOT EXISTS idx_session_cards_session_id_timestamp ON session_cards(session_id, timestamp)",
            [],
        )?;
        tx.pragma_update(None, "user_version", 3)?;
        tx.commit()?;
    }

    Ok(())
}
