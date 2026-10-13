import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { BackupInfo, BackupValidation, SettingsDto } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { PageHeaderComponent } from '../../ui/page-header.component';

@Component({selector:'app-backup-page',imports:[DatePipe,FormsModule,PageHeaderComponent],template:`
 <app-page-header title="Backup & restore" subtitle="Protect your product, sales, order and inventory data."/>@if(error()){<div class="notice notice-bad">{{error()}}</div>}@if(message()){<div class="notice notice-good">{{message()}}</div>}
 @if(config();as c){<section class="card config"><h2>Scheduled backups</h2><label class="check"><input type="checkbox" [(ngModel)]="c.backupAutoEnabled"/>Enable automatic backups</label><div class="fields"><label>Interval (hours)<input class="input" type="number" min="1" max="744" [(ngModel)]="c.backupIntervalHours"/></label><label>Keep newest backups<input class="input" type="number" min="1" max="365" [(ngModel)]="c.backupKeepCount"/></label><label>Backup folder<input class="input" [ngModel]="c.backupDirectory||defaultDirectory()" readonly/></label><button class="btn" (click)="chooseDirectory()">Choose folder</button></div><button class="btn btn-primary" (click)="saveConfig()">Save backup settings</button></section>}
 <section class="card actions"><button class="btn btn-primary" (click)="create()">Create backup now</button><button class="btn" (click)="restore()">Restore from file…</button><button class="btn" (click)="integrity()">Check database integrity</button></section>
 @if(check();as c){<div class="notice" [class.notice-good]="c.ok" [class.notice-bad]="!c.ok">{{c.messages.join(' · ')}}</div>}
 <section class="card">@if(backups().length){<div class="table-wrap"><table class="table"><thead><tr><th>Backup</th><th>Type</th><th>Created</th><th>Size</th></tr></thead><tbody>@for(b of backups();track b.file){<tr><td>{{b.name}}</td><td>{{b.kind}}</td><td>{{b.createdAt|date:'medium'}}</td><td>{{(b.sizeBytes/1048576).toFixed(1)}} MB</td></tr>}</tbody></table></div>}@else{<p class="empty">No backups found.</p>}</section>
`,styles:`.config{padding:16px;margin-bottom:14px}.config h2{font:600 19px var(--font-serif);margin-bottom:12px}.check{display:flex;gap:8px;align-items:center}.fields{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:12px 0}.fields label{display:grid;gap:4px;font-size:11px;min-width:140px;flex:1}.actions{padding:12px;display:flex;gap:8px;margin-bottom:14px}.empty{padding:25px;text-align:center}`})
export class BackupPage {
 private readonly api=inject(ApiService).api;protected readonly backups=signal<BackupInfo[]>([]);protected readonly config=signal<SettingsDto|null>(null);protected readonly check=signal<{ok:boolean;messages:string[]}|null>(null);protected readonly error=signal('');protected readonly message=signal('');protected readonly defaultDirectory=signal('');
 constructor(){void this.load();}
 private async load(){try{const [b,c]=await Promise.all([this.api.backup.list(),this.api.settings.get()]);this.backups.set(b);this.config.set(c);this.defaultDirectory.set(c.backupDirectory||'Application data/backups');}catch(e){this.error.set(messageOf(e));}}
 protected async create(){try{const b=await this.api.backup.create();this.message.set(`Backup created: ${b.name}`);await this.load();}catch(e){this.error.set(messageOf(e));}}
 protected async chooseDirectory(){const dir=await this.api.backup.chooseDirectory();if(dir){this.config.update(c=>c?{...c,backupDirectory:dir}:c);}}
 protected async saveConfig(){const c=this.config();if(!c)return;try{this.config.set(await this.api.settings.update(c));this.message.set('Backup settings saved.');}catch(e){this.error.set(messageOf(e));}}
 protected async integrity(){try{this.check.set(await this.api.backup.runIntegrityCheck());}catch(e){this.error.set(messageOf(e));}}
 protected async restore(){if(!window.confirm('Choose a Vetora POS backup to restore. The current database will first be saved as a safety backup. Continue?'))return;try{const picked=await this.api.backup.pickFile();if(!picked)return;if(!picked.validation.ok)throw new Error(picked.validation.problems.join(' '));const result=await this.api.backup.restore(picked.file);this.message.set(`Restored backup. A safety copy was saved at ${result.safetyBackup}. Sign in again to continue.`);await this.load();}catch(e){this.error.set(messageOf(e));}}
}
