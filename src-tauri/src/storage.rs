use crate::db;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub status: String,
    pub created_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIChatSession {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<AIChatMessage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIChatSessionMetadata {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub preview: String,
}

pub fn save_session(session: &Session) -> anyhow::Result<()> {
    let mut conn = db::get_connection()?;
    let tx = conn.transaction()?;

    // Upsert session without REPLACE semantics. `INSERT OR REPLACE` would delete the
    // existing row first, triggering FK cascades and unintentionally removing linked
    // AI chat sessions/messages.
    tx.execute(
        "INSERT INTO sessions (id, name, created_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           created_at = excluded.created_at",
        params![session.id, session.name, session.created_at as i64],
    )?;

    // Incremental card persistence strategy:
    // 1) Load existing cards for this session
    // 2) Upsert only new/changed cards
    // 3) Delete cards removed from frontend state
    let mut existing_cards: HashMap<String, SessionCard> = HashMap::new();
    {
        let mut load_stmt = tx.prepare(
            "SELECT id, original, translated, status, user, timestamp
             FROM session_cards
             WHERE session_id = ?1",
        )?;

        let rows = load_stmt.query_map(params![session.id], |row| {
            Ok(SessionCard {
                id: row.get(0)?,
                original: row.get(1)?,
                translated: row.get(2)?,
                status: row.get(3)?,
                user: row.get(4)?,
                timestamp: row.get::<_, i64>(5)? as u64,
            })
        })?;

        for row in rows {
            let card = row?;
            existing_cards.insert(card.id.clone(), card);
        }
    }

    let mut incoming_ids: HashSet<String> = HashSet::with_capacity(session.cards.len());

    for card in &session.cards {
        incoming_ids.insert(card.id.clone());

        let should_upsert = match existing_cards.get(&card.id) {
            None => true,
            Some(existing) => {
                existing.original != card.original
                    || existing.translated != card.translated
                    || existing.status != card.status
                    || existing.user != card.user
                    || existing.timestamp != card.timestamp
            }
        };

        if should_upsert {
            tx.execute(
                "INSERT INTO session_cards (id, session_id, original, translated, status, user, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   session_id = excluded.session_id,
                   original = excluded.original,
                   translated = excluded.translated,
                   status = excluded.status,
                   user = excluded.user,
                   timestamp = excluded.timestamp",
                params![
                    card.id,
                    session.id,
                    card.original,
                    card.translated,
                    card.status,
                    card.user,
                    card.timestamp as i64
                ],
            )?;
        }
    }

    for existing_id in existing_cards.keys() {
        if !incoming_ids.contains(existing_id) {
            tx.execute(
                "DELETE FROM session_cards WHERE id = ?1",
                params![existing_id],
            )?;
        }
    }

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

pub fn load_session_original_segments(id: &str) -> anyhow::Result<Vec<String>> {
    let conn = db::get_connection()?;

    let mut stmt = conn.prepare(
        "SELECT original
         FROM session_cards
         WHERE session_id = ?1
         ORDER BY timestamp ASC",
    )?;

    let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;

    let mut segments = Vec::new();
    for row in rows {
        segments.push(row?);
    }

    Ok(segments)
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

pub fn create_ai_chat_session(session_id: &str, name: &str) -> anyhow::Result<AIChatSession> {
    let conn = db::get_connection()?;
    let session_exists: i64 = conn.query_row(
        "SELECT COUNT(1) FROM sessions WHERE id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    if session_exists == 0 {
        return Err(anyhow::anyhow!(
            "Cannot create AI chat session because translation session does not exist: {}",
            session_id
        ));
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let chat_session = AIChatSession {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        name: name.to_string(),
        created_at: now,
        updated_at: now,
        messages: Vec::new(),
    };

    conn.execute(
        "INSERT INTO ai_chat_sessions (id, session_id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            chat_session.id,
            chat_session.session_id,
            chat_session.name,
            chat_session.created_at as i64,
            chat_session.updated_at as i64
        ],
    )?;

    Ok(chat_session)
}

pub fn save_ai_chat_session(chat_session: &AIChatSession) -> anyhow::Result<()> {
    let mut conn = db::get_connection()?;
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO ai_chat_sessions (id, session_id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           name = excluded.name,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![
            chat_session.id,
            chat_session.session_id,
            chat_session.name,
            chat_session.created_at as i64,
            chat_session.updated_at as i64
        ],
    )?;

    let mut existing_messages: HashMap<String, (String, String, String, u64, i64)> = HashMap::new();
    {
        let mut load_stmt = tx.prepare(
            "SELECT
                CAST(COALESCE(NULLIF(id, ''), printf('legacy-msg-%lld', rowid)) AS TEXT) AS id,
                CAST(COALESCE(NULLIF(role, ''), 'assistant') AS TEXT) AS role,
                CAST(COALESCE(content, '') AS TEXT) AS content,
                CAST(COALESCE(NULLIF(status, ''), 'done') AS TEXT) AS status,
                CAST(COALESCE(created_at, 0) AS INTEGER) AS created_at,
                CAST(COALESCE(sequence, rowid) AS INTEGER) AS sequence
             FROM ai_chat_messages
             WHERE chat_session_id = ?1",
        )?;

        let rows = load_stmt.query_map(params![chat_session.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)? as u64,
                row.get::<_, i64>(5)?,
            ))
        })?;

        for row in rows {
            let (id, role, content, status, created_at, sequence) = row?;
            existing_messages.insert(id, (role, content, status, created_at, sequence));
        }
    }

    let mut incoming_ids: HashSet<String> = HashSet::with_capacity(chat_session.messages.len());
    for (index, message) in chat_session.messages.iter().enumerate() {
        let sequence = index as i64;
        incoming_ids.insert(message.id.clone());

        let should_upsert = match existing_messages.get(&message.id) {
            None => true,
            Some((role, content, status, created_at, existing_sequence)) => {
                role != &message.role
                    || content != &message.content
                    || status != &message.status
                    || *created_at != message.created_at
                    || *existing_sequence != sequence
            }
        };

        if should_upsert {
            tx.execute(
                "INSERT INTO ai_chat_messages
                    (id, chat_session_id, role, content, status, created_at, sequence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   chat_session_id = excluded.chat_session_id,
                   role = excluded.role,
                   content = excluded.content,
                   status = excluded.status,
                   created_at = excluded.created_at,
                   sequence = excluded.sequence",
                params![
                    message.id,
                    chat_session.id,
                    message.role,
                    message.content,
                    message.status,
                    message.created_at as i64,
                    sequence
                ],
            )?;
        }
    }

    for existing_id in existing_messages.keys() {
        if !incoming_ids.contains(existing_id) {
            tx.execute(
                "DELETE FROM ai_chat_messages WHERE id = ?1",
                params![existing_id],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}

pub fn load_ai_chat_session(id: &str) -> anyhow::Result<AIChatSession> {
    let conn = db::get_connection()?;

    let (session_id, name, created_at, updated_at): (String, String, i64, i64) = conn.query_row(
        "SELECT
            CAST(COALESCE(session_id, '') AS TEXT) AS session_id,
            CAST(COALESCE(NULLIF(name, ''), '[Legacy Chat]') AS TEXT) AS name,
            CAST(COALESCE(created_at, 0) AS INTEGER) AS created_at,
            CAST(COALESCE(updated_at, created_at, 0) AS INTEGER) AS updated_at
         FROM ai_chat_sessions
         WHERE id = ?1
            OR (id IS NULL AND printf('legacy-chat-%lld', rowid) = ?1)",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;

    let mut stmt = conn.prepare(
        "SELECT
            CAST(COALESCE(NULLIF(id, ''), printf('legacy-msg-%lld', rowid)) AS TEXT) AS id,
            CAST(COALESCE(NULLIF(role, ''), 'assistant') AS TEXT) AS role,
            CAST(COALESCE(content, '') AS TEXT) AS content,
            CAST(COALESCE(NULLIF(status, ''), 'done') AS TEXT) AS status,
            CAST(COALESCE(created_at, 0) AS INTEGER) AS created_at,
            CAST(COALESCE(sequence, rowid) AS INTEGER) AS sequence
         FROM ai_chat_messages
         WHERE chat_session_id = ?1
         ORDER BY sequence ASC, created_at ASC",
    )?;

    let message_iter = stmt.query_map(params![id], |row| {
        Ok(AIChatMessage {
            id: row.get(0)?,
            role: row.get(1)?,
            content: row.get(2)?,
            status: row.get(3)?,
            created_at: row.get::<_, i64>(4)?.max(0) as u64,
        })
    })?;

    let mut messages = Vec::new();
    for message in message_iter {
        messages.push(message?);
    }

    Ok(AIChatSession {
        id: id.to_string(),
        session_id,
        name,
        created_at: created_at as u64,
        updated_at: updated_at as u64,
        messages,
    })
}

pub fn list_ai_chat_sessions(session_id: &str) -> anyhow::Result<Vec<AIChatSessionMetadata>> {
    let conn = db::get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT
            CAST(COALESCE(NULLIF(s.id, ''), printf('legacy-chat-%lld', s.rowid)) AS TEXT) AS id,
            CAST(COALESCE(s.session_id, '') AS TEXT) AS session_id,
            CAST(COALESCE(NULLIF(s.name, ''), '[Legacy Chat]') AS TEXT) AS name,
            CAST(COALESCE(s.created_at, 0) AS INTEGER) AS created_at,
            CAST(COALESCE(s.updated_at, s.created_at, 0) AS INTEGER) AS updated_at,
            COALESCE(
              (
                SELECT m.content
                FROM ai_chat_messages m
                WHERE m.chat_session_id = s.id
                ORDER BY COALESCE(m.sequence, m.rowid) DESC, COALESCE(m.created_at, 0) DESC
                LIMIT 1
              ),
              ''
            ) AS preview
         FROM ai_chat_sessions s
         WHERE s.session_id = ?1
           AND EXISTS (
             SELECT 1
             FROM ai_chat_messages um
             WHERE um.chat_session_id = s.id
               AND um.role = 'user'
           )
         ORDER BY s.updated_at DESC, s.created_at DESC",
    )?;

    let iter = stmt.query_map(params![session_id], |row| {
        let preview: String = row.get(5)?;
        Ok(AIChatSessionMetadata {
            id: row.get(0)?,
            session_id: row.get(1)?,
            name: row.get(2)?,
            created_at: row.get::<_, i64>(3)? as u64,
            updated_at: row.get::<_, i64>(4)? as u64,
            preview: preview.chars().take(80).collect(),
        })
    })?;

    let mut sessions = Vec::new();
    for item in iter {
        sessions.push(item?);
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
