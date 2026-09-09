import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import { RootProvider } from 'fumadocs-ui/provider/react-router';
import type { Route } from './+types/root';
import 'virtual:uno.css';
import 'virtual:fumadocs-compat.css';
import './app.css';
import SearchDialog from '@/components/search';
import { trackerProps } from '@/lib/telemetry';
import NotFound from './routes/not-found';
import { PaletteProvider } from '@/components/palette';

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap',
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script defer {...trackerProps} />
      </head>
      <body className="site:flex site:flex-col site:min-h-screen">
        <RootProvider search={{ SearchDialog }}><PaletteProvider>{children}</PaletteProvider></RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) return <NotFound />;
    message = 'Error';
    details = error.statusText;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="site:pt-16 site:p-4 site:w-full site:max-w-[1400px] site:mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="site:w-full site:p-4 site:overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
