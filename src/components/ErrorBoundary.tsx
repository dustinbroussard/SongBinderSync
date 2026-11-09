import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw, Home } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[SongBinder ErrorBoundary] Caught error:", error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = "/";
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen w-full flex items-center justify-center p-6 bg-bg-primary text-white">
          <div className="bg-bg-secondary border border-border p-8 rounded-2xl max-w-md w-full shadow-elevation text-center">
            <div className="w-16 h-16 bg-danger/10 text-danger rounded-2xl flex items-center justify-center mx-auto mb-6">
              <AlertTriangle className="w-8 h-8" />
            </div>
            
            <h2 className="text-xl font-bold font-mono-tech mb-2">Something went wrong</h2>
            <p className="text-sm text-gray-400 mb-6 leading-relaxed">
              An unexpected error occurred while rendering this view. Your saved songs and setlists in IndexedDB remain safe.
            </p>

            {this.state.error?.message && (
              <div className="bg-bg-tertiary p-3 rounded-lg border border-border text-left mb-6 overflow-x-auto">
                <p className="text-xs font-mono-tech text-gray-400 break-all">
                  {this.state.error.message}
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={this.handleReset}
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4 bg-primary-accent text-black font-bold text-xs uppercase tracking-wider rounded-xl hover:opacity-90 transition-opacity"
              >
                <RotateCcw className="w-4 h-4" />
                Try Again
              </button>
              <button
                onClick={this.handleGoHome}
                className="flex-1 flex items-center justify-center gap-2 py-3 px-4 bg-bg-tertiary text-gray-300 font-bold text-xs uppercase tracking-wider rounded-xl hover:text-white hover:bg-bg-quaternary transition-colors border border-border"
              >
                <Home className="w-4 h-4" />
                Return Home
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
