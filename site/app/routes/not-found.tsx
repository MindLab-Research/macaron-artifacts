import type { Route } from './+types/not-found';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Link } from 'react-router';
import { baseOptions } from '@/lib/layout.shared';

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Not Found' }];
}

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="site:p-4 site:flex site:flex-col site:items-center site:justify-center site:text-center site:flex-1">
        <h1 className="site:text-xl site:font-bold site:mb-2">Not Found</h1>
        <p className="site:text-fd-muted-foreground site:mb-4">This page could not be found.</p>
        <Link
          className="site:text-sm site:bg-fd-primary site:text-fd-primary-foreground site:rounded-full site:font-medium site:px-4 site:py-2.5"
          to="/docs"
        >
          Back to Docs
        </Link>
      </div>
    </HomeLayout>
  );
}
