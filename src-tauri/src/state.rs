use crate::translation::TranslationService;
use crate::AppConfig;
use crate::CaptionThreadCommand;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub translation_service: Mutex<Option<TranslationService>>,
    pub active_translation_requests: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    pub caption_running: AtomicBool,
    pub caption_command_sender: Mutex<Option<Sender<CaptionThreadCommand>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            config: Mutex::new(AppConfig::default()),
            translation_service: Mutex::new(None),
            active_translation_requests: Arc::new(Mutex::new(HashMap::new())),
            caption_running: AtomicBool::new(false),
            caption_command_sender: Mutex::new(None),
        }
    }
}
