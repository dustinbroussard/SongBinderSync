# SongBinder

A digital gig bag for musicians to manage songs, setlists, and perform on stage.

## Features

- **Song Library**: Manage your complete song catalog with lyrics, metadata, and tags
- **Setlist Management**: Create and organize setlists for performances
- **Song Editor**: Edit songs with rich metadata including:
  - Key, tempo, and time signature
  - Performance notes and production notes
  - Custom font size, scroll speed, and text alignment
  - Multiple layout modes (standard/split)
  - Font family selection (sans/serif/mono)
- **Performance Mode**: On-stage performance view with:
  - Auto-scroll with configurable speed and delay
  - Split-screen layout for lyrics and notes
  - Performance-specific display settings
- **Document Import**: Import songs from various formats:
  - OCR support for scanning physical documents (Tesseract.js)
  - Word document support (.docx)
  - PDF export capability
- **AI Integration**: Google Gemini AI for intelligent song management
- **Offline Support**: PWA with service worker for offline access
- **Authentication**: Supabase-based user authentication
- **Drag & Drop**: Intuitive drag-and-drop interface for setlist organization
- **Dark Theme**: Built-in theme support with dark mode
- **Responsive Design**: Works on desktop, tablet, and mobile devices

## Tech Stack

- **Frontend**: React 19, TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4
- **Backend**: Supabase (authentication, database)
- **Local Storage**: Dexie (IndexedDB wrapper)
- **AI**: Google Gemini AI
- **OCR**: Tesseract.js
- **PDF Generation**: jsPDF
- **Document Processing**: Mammoth (Word documents)
- **Drag & Drop**: @dnd-kit
- **Routing**: React Router v7
- **Animations**: Motion
- **Icons**: Lucide React
- **PWA**: vite-plugin-pwa

## Prerequisites

- Node.js 18+
- A Supabase project (for authentication and database)
- A Google Gemini API key

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd SongBinderSync
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` and add your credentials:
```env
GEMINI_API_KEY="your-gemini-api-key"
APP_URL="http://localhost:3000"
SUPABASE_URL="https://your-project-ref.supabase.co"
SUPABASE_ANON_KEY="your-public-anon-key"
```

## Development

Start the development server:
```bash
npm run dev
```

The app will be available at `http://localhost:3000`

## Building

Build for production:
```bash
npm run build
```

Preview the production build:
```bash
npm run preview
```

## Deployment

The app is configured for deployment on Vercel. The `vercel.json` file handles SPA routing by redirecting all routes to `index.html`.

To deploy:
1. Push your code to a Git repository
2. Import the project in Vercel
3. Add environment variables in Vercel dashboard
4. Deploy

### Environment Variables for Production

- `GEMINI_API_KEY`: Your Google Gemini API key
- `APP_URL`: Your production URL (e.g., https://your-app.vercel.app)
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_ANON_KEY`: Your Supabase anonymous/public key

## Available Scripts

- `npm run dev` - Start development server on port 3000
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run clean` - Remove dist directory
- `npm run lint` - Run TypeScript type checking

## Project Structure

```
src/
├── components/       # Reusable UI components
│   ├── AuthProvider.tsx
│   ├── ThemeProvider.tsx
│   ├── InstallPrompt.tsx
│   └── ...
├── pages/           # Page components
│   ├── MainLayout.tsx
│   ├── SongsLibrary.tsx
│   ├── SetlistsManager.tsx
│   ├── SetlistDetail.tsx
│   ├── SongEditor.tsx
│   ├── PerformanceMode.tsx
│   └── SignIn.tsx
├── hooks/           # Custom React hooks
├── lib/             # Utility libraries
├── types.ts         # TypeScript type definitions
├── App.tsx          # Main app component
└── main.tsx         # Entry point
```

## License

Apache-2.0