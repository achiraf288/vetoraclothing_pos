import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SessionService } from './core/session.service';
import { SettingsStore } from './core/settings.store';
import { ShellOverlaysComponent } from './ui/shell-overlays.component';

interface NavItem { label: string; path: string; perm: string; icon: string; }
interface NavGroup { title: string; items: NavItem[]; }

const NAV: NavGroup[] = [
  { title: 'Overview', items: [{ label: 'Dashboard', path: '/dashboard', perm: 'dashboard.read', icon: '◧' }] },
  { title: 'Selling', items: [
    { label: 'Point of sale', path: '/pos', perm: 'sales.create', icon: '◉' },
    { label: 'Sales', path: '/sales', perm: 'sales.read', icon: '☰' },
    { label: 'Orders & delivery', path: '/orders', perm: 'sales.create', icon: '▤' },
    { label: 'Returns', path: '/returns', perm: 'returns.create', icon: '↺' },
  ] },
  { title: 'Catalogue', items: [
    { label: 'Products', path: '/products', perm: 'catalog.read', icon: '◇' },
    { label: 'Stock', path: '/inventory/stock', perm: 'inventory.read', icon: '▦' },
    { label: 'Stock movements', path: '/inventory/movements', perm: 'inventory.read', icon: '⇅' },
    { label: 'Valuation', path: '/inventory/valuation', perm: 'inventory.adjust', icon: '≋' },
  ] },
  { title: 'Purchasing', items: [
    { label: 'Suppliers', path: '/suppliers', perm: 'purchases.manage', icon: '❖' },
    { label: 'Purchases', path: '/purchases', perm: 'purchases.manage', icon: '⊞' },
    { label: 'Supplier returns', path: '/purchases/returns', perm: 'purchases.manage', icon: '⇤' },
  ] },
  { title: 'Business', items: [
    { label: 'Expenses', path: '/expenses', perm: 'expenses.manage', icon: '◔' },
    { label: 'Reports', path: '/reports', perm: 'reports.read', icon: '◭' },
    { label: 'Settings', path: '/settings', perm: 'settings.read', icon: '⚙' },
  ] },
];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ShellOverlaysComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly session = inject(SessionService);
  protected readonly settings = inject(SettingsStore);
  private readonly router = inject(Router);

  protected readonly groups = computed(() =>
    NAV.map((g) => ({ ...g, items: g.items.filter((i) => this.session.can(i.perm)) })).filter((g) => g.items.length),
  );
  /** Pages shown without the sidebar shell. */
  protected readonly bare = () => ['/login', '/setup'].some((p) => this.router.url.startsWith(p)) || !this.session.session();
  protected readonly initials = computed(() =>
    (this.session.user()?.displayName ?? '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase(),
  );

  protected signOut(): void { void this.session.logout(); }
}
