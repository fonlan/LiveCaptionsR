use anyhow::anyhow;
use rusqlite::{Connection, Transaction};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

static DB_INIT_RESULT: OnceLock<Result<(), String>> = OnceLock::new();
pub fn get_db_path() -> anyhow::Result<PathBuf> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?
        .join("LiveCaptionsR");

    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir)?;
    }

    Ok(config_dir.join("data.db"))
}

fn open_connection() -> anyhow::Result<Connection> {
    let path = get_db_path()?;
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(8))?;
    conn.execute("PRAGMA foreign_keys = ON", [])?;
    Ok(conn)
}

fn ensure_initialized() -> anyhow::Result<()> {
    let init_result = DB_INIT_RESULT.get_or_init(|| init_schema().map_err(|e| e.to_string()));
    match init_result {
        Ok(()) => Ok(()),
        Err(message) => Err(anyhow!(message.clone())),
    }
}

pub fn get_connection() -> anyhow::Result<Connection> {
    ensure_initialized()?;
    open_connection()
}

fn table_columns(tx: &Transaction<'_>, table_name: &str) -> anyhow::Result<HashSet<String>> {
    let mut stmt = tx.prepare(&format!("PRAGMA table_info({})", table_name))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;

    let mut columns = HashSet::new();
    for row in rows {
        columns.insert(row?.to_ascii_lowercase());
    }
    Ok(columns)
}

fn ensure_column(
    tx: &Transaction<'_>,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
    backfill_expression: &str,
) -> anyhow::Result<()> {
    let columns = table_columns(tx, table_name)?;
    if !columns.contains(&column_name.to_ascii_lowercase()) {
        tx.execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                table_name, column_name, column_definition
            ),
            [],
        )?;
    }

    tx.execute(
        &format!(
            "UPDATE {} SET {} = {} WHERE {} IS NULL",
            table_name, column_name, backfill_expression, column_name
        ),
        [],
    )?;
    Ok(())
}

fn migrate_ai_chat_schema_v5(tx: &Transaction<'_>) -> anyhow::Result<()> {
    tx.execute(
        "CREATE TABLE IF NOT EXISTS ai_chat_sessions (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )",
        [],
    )?;
    tx.execute(
        "CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id TEXT PRIMARY KEY,
            chat_session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            sequence INTEGER NOT NULL,
            FOREIGN KEY(chat_session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
        )",
        [],
    )?;

    ensure_column(
        tx,
        "ai_chat_sessions",
        "id",
        "TEXT",
        "printf('legacy-chat-%lld', rowid)",
    )?;
    ensure_column(tx, "ai_chat_sessions", "session_id", "TEXT", "session_id")?;
    ensure_column(tx, "ai_chat_sessions", "name", "TEXT", "'[Legacy Chat]'")?;
    ensure_column(tx, "ai_chat_sessions", "created_at", "INTEGER", "0")?;
    ensure_column(
        tx,
        "ai_chat_sessions",
        "updated_at",
        "INTEGER",
        "COALESCE(created_at, 0)",
    )?;

    ensure_column(
        tx,
        "ai_chat_messages",
        "id",
        "TEXT",
        "printf('legacy-msg-%lld', rowid)",
    )?;
    ensure_column(
        tx,
        "ai_chat_messages",
        "chat_session_id",
        "TEXT",
        "chat_session_id",
    )?;
    ensure_column(tx, "ai_chat_messages", "role", "TEXT", "'assistant'")?;
    ensure_column(tx, "ai_chat_messages", "content", "TEXT", "''")?;
    ensure_column(tx, "ai_chat_messages", "status", "TEXT", "'done'")?;
    ensure_column(tx, "ai_chat_messages", "created_at", "INTEGER", "0")?;
    ensure_column(tx, "ai_chat_messages", "sequence", "INTEGER", "rowid")?;

    tx.execute(
        "UPDATE ai_chat_sessions
         SET id = printf('legacy-chat-%lld', rowid)
         WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''",
        [],
    )?;
    tx.execute(
        "UPDATE ai_chat_sessions
         SET name = '[Legacy Chat]'
         WHERE name IS NULL OR TRIM(name) = ''",
        [],
    )?;
    tx.execute(
        "UPDATE ai_chat_sessions
         SET updated_at = COALESCE(updated_at, created_at, 0)",
        [],
    )?;
    tx.execute(
        "UPDATE ai_chat_messages
         SET id = printf('legacy-msg-%lld', rowid)
         WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''",
        [],
    )?;
    tx.execute(
        "UPDATE ai_chat_messages
         SET role = 'assistant'
         WHERE role IS NULL OR TRIM(role) = ''",
        [],
    )?;
    tx.execute(
        "UPDATE ai_chat_messages
         SET status = 'done'
         WHERE status IS NULL OR TRIM(status) = ''",
        [],
    )?;
    tx.execute(
        "UPDATE ai_chat_messages
         SET sequence = rowid
         WHERE sequence IS NULL",
        [],
    )?;

    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_session_id_updated_at
         ON ai_chat_sessions(session_id, updated_at DESC)",
        [],
    )?;
    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_chat_session_id_sequence
         ON ai_chat_messages(chat_session_id, sequence)",
        [],
    )?;
    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_id
         ON ai_chat_sessions(id)",
        [],
    )?;
    tx.execute(
        "CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_id
         ON ai_chat_messages(id)",
        [],
    )?;

    Ok(())
}

fn init_schema() -> anyhow::Result<()> {
    let mut conn = open_connection()?;

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

    let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current_version < 4 {
        let tx = conn.transaction()?;
        tx.execute(
            "CREATE TABLE IF NOT EXISTS ai_chat_sessions (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )",
            [],
        )?;
        tx.execute(
            "CREATE TABLE IF NOT EXISTS ai_chat_messages (
                id TEXT PRIMARY KEY,
                chat_session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                sequence INTEGER NOT NULL,
                FOREIGN KEY(chat_session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
            )",
            [],
        )?;
        tx.execute(
            "CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_session_id_updated_at
             ON ai_chat_sessions(session_id, updated_at DESC)",
            [],
        )?;
        tx.execute(
            "CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_chat_session_id_sequence
             ON ai_chat_messages(chat_session_id, sequence)",
            [],
        )?;
        tx.pragma_update(None, "user_version", 4)?;
        tx.commit()?;
    }

    let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current_version < 5 {
        let tx = conn.transaction()?;
        migrate_ai_chat_schema_v5(&tx)?;
        tx.pragma_update(None, "user_version", 5)?;
        tx.commit()?;
    }

    // v6: one-time legacy self-heal pass for users who upgraded through an
    // older build that did not finish the v5 schema cleanup. Brand-new
    // installs land directly on v6 via the v5 block above and skip this.
    let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current_version < 6 {
        let tx = conn.transaction()?;
        migrate_ai_chat_schema_v5(&tx)?;
        tx.pragma_update(None, "user_version", 6)?;
        tx.commit()?;
    }

    Ok(())
}
