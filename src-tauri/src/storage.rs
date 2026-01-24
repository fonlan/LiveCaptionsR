use crate::db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub cards: Vec<SessionCard>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionCard {
    pub id: String,
    pub original: String,
    pub translated: Option<String>,
    pub status: Option<String>,
    pub user: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionMetadata {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub preview: String,
}

pub fn save_session(session: &Session) -> anyhow::Result<()> {
    let mut conn = db::get_connection()?;
    let tx = conn.transaction()?;

    // Upsert session
    tx.execute(
        "INSERT OR REPLACE INTO sessions (id, name, created_at) VALUES (?1, ?2, ?3)",
        params![session.id, session.name, session.created_at as i64],
    )?;

    // Replace cards strategy: Delete all and re-insert
    // This handles edits/deletions on the frontend side
    tx.execute(
        "DELETE FROM session_cards WHERE session_id = ?1",
        params![session.id],
    )?;

    let mut stmt = tx.prepare(
        "INSERT INTO session_cards (id, session_id, original, translated, status, user, timestamp) 
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;

    for card in &session.cards {
        stmt.execute(params![
            card.id,
            session.id,
            card.original,
            card.translated,
            card.status,
            card.user,
            card.timestamp as i64
        ])?;
    }
    drop(stmt);

    tx.commit()?;
    Ok(())
}

pub fn load_session(id: &str) -> anyhow::Result<Session> {
    let conn = db::get_connection()?;

    // Get session info
    let (name, created_at): (String, i64) = conn.query_row(
        "SELECT name, created_at FROM sessions WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    // Get cards
    let mut stmt = conn.prepare(
        "SELECT id, original, translated, status, user, timestamp 
         FROM session_cards 
         WHERE session_id = ?1 
         ORDER BY timestamp ASC",
    )?;

    let card_iter = stmt.query_map(params![id], |row| {
        Ok(SessionCard {
            id: row.get(0)?,
            original: row.get(1)?,
            translated: row.get(2)?,
            status: row.get(3)?,
            user: row.get(4)?,
            timestamp: row.get::<_, i64>(5)? as u64,
        })
    })?;

    let mut cards = Vec::new();
    for card in card_iter {
        cards.push(card?);
    }

    Ok(Session {
        id: id.to_string(),
        name,
        created_at: created_at as u64,
        cards,
    })
}

pub fn list_sessions() -> anyhow::Result<Vec<SessionMetadata>> {
    let conn = db::get_connection()?;

    let mut stmt = conn.prepare(
        "SELECT 
            s.id, 
            s.name, 
            s.created_at, 
            (SELECT original FROM session_cards WHERE session_id = s.id ORDER BY timestamp ASC LIMIT 1) as preview 
         FROM sessions s 
         ORDER BY s.created_at DESC"
    )?;

    let session_iter = stmt.query_map([], |row| {
        let preview: Option<String> = row.get(3)?;
        Ok(SessionMetadata {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get::<_, i64>(2)? as u64,
            preview: preview.unwrap_or_default().chars().take(50).collect(),
        })
    })?;

    let mut sessions = Vec::new();
    for session in session_iter {
        sessions.push(session?);
    }

    Ok(sessions)
}

pub fn delete_session(id: &str) -> anyhow::Result<()> {
    let conn = db::get_connection()?;
    // Foreign keys are enabled in db::get_connection, so cascading delete should work.
    // But explicit delete is safer if we ever disable FKs.
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn delete_all_sessions() -> anyhow::Result<()> {
    let conn = db::get_connection()?;
    conn.execute("DELETE FROM sessions", [])?;
    Ok(())
}
