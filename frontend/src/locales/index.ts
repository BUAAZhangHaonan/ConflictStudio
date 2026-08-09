import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LOCALE_STORAGE_KEY } from '../mock';
import enUS from './en-US';
import {
  workspaceSettingsStatisticsEnUS,
  workspaceSettingsStatisticsZhCN,
} from './features/workspaceSettingsStatistics';
import zhCN from './zh-CN';

const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
const initialLocale = storedLocale === 'en-US' ? 'en-US' : 'zh-CN';

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': {
      translation: {
        ...zhCN,
        workspaceSettingsStatistics: workspaceSettingsStatisticsZhCN,
      },
    },
    'en-US': {
      translation: {
        ...enUS,
        workspaceSettingsStatistics: workspaceSettingsStatisticsEnUS,
      },
    },
  },
  lng: initialLocale,
  fallbackLng: false,
  supportedLngs: ['zh-CN', 'en-US'],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
