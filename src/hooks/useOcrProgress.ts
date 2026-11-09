import { useState, useCallback, useRef, useEffect } from "react";
import { runOcrInWorker, formatOcrStatus } from "../lib/ocrService";

export interface UseOcrProgressOptions {
  /** Default language for Tesseract recognition (default: 'eng') */
  language?: string;
  /** Callback fired whenever progress or status changes */
  onProgress?: (progress: number, status: string, rawStatus: string) => void;
  /** Callback fired upon successful OCR completion */
  onSuccess?: (text: string) => void;
  /** Callback fired upon failure */
  onError?: (error: Error) => void;
}

export interface UseOcrProgressReturn {
  /** Real-time user-facing stage: 'Idle', 'Initializing', 'Recognizing text', 'Finalizing', etc. */
  status: string;
  /** Raw low-level status string from the OCR engine */
  rawStatus: string;
  /** Float progress between 0.0 and 1.0 */
  progress: number;
  /** Integer percentage between 0 and 100 */
  progressPercent: number;
  /** True while the worker is actively analyzing the image */
  isProcessing: boolean;
  /** Final recognized plain text */
  result: string | null;
  /** Error message if OCR or worker failed */
  error: string | null;
  /** Dispatches an image file/blob to the dedicated Web Worker */
  recognize: (file: File | Blob, customLanguage?: string) => Promise<string>;
  /** Cancels any in-flight OCR job and terminates the worker */
  cancel: () => void;
  /** Resets state back to initial idle values */
  reset: () => void;
}

/**
 * Custom React hook that communicates with the Tesseract Web Worker to provide
 * non-blocking OCR recognition with real-time status updates and progress tracking.
 */
export function useOcrProgress(options: UseOcrProgressOptions = {}): UseOcrProgressReturn {
  const { language = "eng", onProgress, onSuccess, onError } = options;

  const [status, setStatus] = useState<string>("Idle");
  const [rawStatus, setRawStatus] = useState<string>("");
  const [progress, setProgress] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setStatus("Idle");
    setRawStatus("");
    setProgress(0);
    setIsProcessing(false);
    setError(null);
    setResult(null);
  }, []);

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsProcessing(false);
    setStatus("Cancelled");
  }, []);

  // Ensure worker is terminated and abort controller is cleaned up on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  const recognize = useCallback(
    async (file: File | Blob, customLanguage?: string): Promise<string> => {
      // Abort previous job if still running
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsProcessing(true);
      setError(null);
      setProgress(0);
      setStatus("Initializing");
      setRawStatus("initializing tesseract");

      try {
        const text = await runOcrInWorker(file, {
          language: customLanguage || language,
          signal: controller.signal,
          onProgress: (prog, formattedStatus, raw) => {
            setProgress(prog);
            setStatus(formattedStatus);
            setRawStatus(raw);
            onProgress?.(prog, formattedStatus, raw);
          },
        });

        setStatus("Completed");
        setProgress(1);
        setResult(text);
        setIsProcessing(false);
        abortControllerRef.current = null;
        onSuccess?.(text);
        return text;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          setIsProcessing(false);
          setStatus("Cancelled");
          throw err;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        setError(errMsg);
        setStatus("Error");
        setIsProcessing(false);
        abortControllerRef.current = null;

        const errorObj = err instanceof Error ? err : new Error(errMsg);
        onError?.(errorObj);
        throw errorObj;
      }
    },
    [language, onProgress, onSuccess, onError]
  );

  return {
    status,
    rawStatus,
    progress,
    progressPercent: Math.min(100, Math.max(0, Math.round(progress * 100))),
    isProcessing,
    result,
    error,
    recognize,
    cancel,
    reset,
  };
}
