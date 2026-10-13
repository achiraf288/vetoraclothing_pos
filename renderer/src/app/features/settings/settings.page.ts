import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { PageHeaderComponent } from '../../ui/page-header.component';

@Component({selector:'app-settings-page',imports:[RouterLink,RouterLinkActive,RouterOutlet,PageHeaderComponent],template:`
  <app-page-header title="Settings" subtitle="Configure your shop, checkout and staff." />
  <div class="settings"><nav class="card tabs"><a routerLink="general" routerLinkActive="active">Shop details</a><a routerLink="payments" routerLinkActive="active">Payments & discounts</a><a routerLink="users" routerLinkActive="active">Users</a><a routerLink="backup" routerLinkActive="active">Backup</a><a routerLink="audit" routerLinkActive="active">Audit log</a><a routerLink="about" routerLinkActive="active">About</a></nav><div><router-outlet /></div></div>
`,styles:`.settings{display:grid;grid-template-columns:190px minmax(0,1fr);gap:16px}.tabs{padding:8px;display:grid;align-content:start;gap:4px;height:max-content}.tabs a{padding:9px 10px;border-radius:6px;color:var(--ink-2);text-decoration:none}.tabs a.active,.tabs a:hover{background:var(--cream);color:var(--ink)}@media(max-width:750px){.settings{grid-template-columns:1fr}.tabs{grid-template-columns:repeat(3,1fr)}}`})
export class SettingsPage {}
