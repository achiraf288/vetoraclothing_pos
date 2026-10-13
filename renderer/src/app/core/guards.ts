import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** Requires a signed-in user; sends first-run installs to /setup. */
export const authGuard: CanActivateFn = () => {
  const s = inject(SessionService);
  const r = inject(Router);
  if (s.session()) return true;
  return r.parseUrl(s.needsSetup() ? '/setup' : '/login');
};

/** Route `data: { perm: 'reports.read' }` restricts a page to users holding that permission. */
export const permGuard: CanActivateFn = (route) => {
  const s = inject(SessionService);
  const r = inject(Router);
  const perm = route.data['perm'] as string | undefined;
  if (!perm || s.can(perm)) return true;
  return r.parseUrl('/forbidden');
};

/** Sends '/' to the dashboard for admins and to the till for cashiers. */
export const landingGuard: CanActivateFn = () => {
  const s = inject(SessionService);
  return inject(Router).parseUrl(s.can('dashboard.read') ? '/dashboard' : '/pos');
};
