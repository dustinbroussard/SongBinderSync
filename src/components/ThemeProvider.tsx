import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "dark" | "light" | "system";
type Accent = "green" | "blue" | "red" | "purple" | "orange" | "gold" | "old-gold";

type ThemeProviderProps = {
  children: ReactNode;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
};

const initialState: ThemeProviderState = {
  theme: "dark",
  setTheme: () => null,
  accent: "green",
  setAccent: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("theme") as Theme) || "dark"
  );
  const [accent, setAccent] = useState<Accent>(
    () => (localStorage.getItem("accent") as Accent) || "green"
  );

  useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove("light", "dark", "light-mode", "dark-mode");
    root.classList.remove("accent-green", "accent-blue", "accent-red", "accent-purple", "accent-orange", "accent-gold", "accent-old-gold");

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";

      root.classList.add(systemTheme);
      root.classList.add(`${systemTheme}-mode`);
    } else {
      root.classList.add(theme);
      root.classList.add(`${theme}-mode`);
    }

    root.classList.add(`accent-${accent}`);
  }, [theme, accent]);

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      localStorage.setItem("theme", theme);
      setTheme(theme);
    },
    accent,
    setAccent: (accent: Accent) => {
      localStorage.setItem("accent", accent);
      setAccent(accent);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");

  return context;
};
