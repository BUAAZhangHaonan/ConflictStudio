import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';

interface ToastMessage {
  id: string;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const dismiss = useCallback((id: string) => {
    setMessages(current => current.filter(message => message.id !== id));
  }, []);
  const showToast = useCallback((message: string) => {
    const id = crypto.randomUUID();
    setMessages(current => [...current, { id, message }]);
    window.setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);
  const value = useMemo(() => ({ showToast }), [showToast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="false">
        {messages.map(message => (
          <div className="toast" role="status" key={message.id}>
            <span>{message.message}</span>
            <button type="button" onClick={() => dismiss(message.id)} aria-label={t('toast.dismissed')}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('ToastProvider is required.');
  return context;
}
