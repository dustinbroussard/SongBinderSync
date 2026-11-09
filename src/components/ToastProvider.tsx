import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);

    setTimeout(() => {
      removeToast(id);
    }, 3500);
  }, [removeToast]);

  const success = useCallback((message: string) => toast(message, "success"), [toast]);
  const error = useCallback((message: string) => toast(message, "error"), [toast]);
  const info = useCallback((message: string) => toast(message, "info"), [toast]);

  return (
    <ToastContext.Provider value={{ toast, success, error, info }}>
      {children}
      <div 
        aria-live="polite" 
        className="fixed bottom-5 right-5 z-[10000] flex flex-col gap-2 max-w-sm w-full pointer-events-none p-4 sm:p-0"
      >
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className={`pointer-events-auto flex items-center justify-between gap-3 p-4 rounded-xl border shadow-elevation backdrop-blur-md ${
                t.type === "error"
                  ? "bg-danger/15 border-danger/40 text-white"
                  : t.type === "success"
                  ? "bg-primary-accent/15 border-primary-accent/40 text-white"
                  : "bg-bg-secondary/90 border-border text-white"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                {t.type === "error" && <AlertCircle className="w-5 h-5 text-danger shrink-0" />}
                {t.type === "success" && <CheckCircle2 className="w-5 h-5 text-primary-accent shrink-0" />}
                {t.type === "info" && <Info className="w-5 h-5 text-blue-400 shrink-0" />}
                <p className="text-xs font-semibold leading-snug break-words">{t.message}</p>
              </div>
              <button
                onClick={() => removeToast(t.id)}
                aria-label="Dismiss notification"
                className="text-gray-400 hover:text-white transition-colors p-1 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
