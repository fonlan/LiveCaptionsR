use crate::translation::TranslationService;
use crate::AppConfig;
use crate::CaptionThreadCommand;
use std::sync::mpsc::Sender;
use std::sync::Mutex;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub translation_service: Mutex<Option<TranslationService>>,
    pub caption_running: Mutex<bool>,
    pub caption_command_sender: Mutex<Option<Sender<CaptionThreadCommand>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            config: Mutex::new(AppConfig::default()),
            translation_service: Mutex::new(None),
            caption_running: Mutex::new(false),
            caption_command_sender: Mutex::new(None),
        }
    }
}
