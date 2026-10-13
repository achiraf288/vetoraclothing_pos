import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Role, UserDto } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { PageHeaderComponent } from '../../ui/page-header.component';

@Component({selector:'app-users-page',imports:[FormsModule,PageHeaderComponent],template:`
 <app-page-header title="Staff accounts" subtitle="Create administrator and cashier logins for this computer." />@if(error()){<div class="notice notice-bad">{{error()}}</div>}
 <section class="card form"><h2>Add staff member</h2><div class="fields"><label>Username<input class="input" [(ngModel)]="username" autocomplete="off" /></label><label>Display name<input class="input" [(ngModel)]="displayName" /></label><label>Role<select class="select" [(ngModel)]="role"><option value="cashier">Cashier</option><option value="admin">Administrator</option></select></label><label>Password<input class="input" type="password" [(ngModel)]="password" autocomplete="new-password" /></label><button class="btn btn-primary" (click)="create()">Create user</button></div></section>
 <section class="card">@if(users().length){<div class="table-wrap"><table class="table"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>@for(u of users();track u.id){<tr><td>{{u.username}}</td><td><input class="input name" [ngModel]="u.displayName" (ngModelChange)="u.displayName=$event" (blur)="update(u,{displayName:u.displayName})" /></td><td><select class="select" [ngModel]="u.role" (ngModelChange)="update(u,{role:$event})"><option value="cashier">Cashier</option><option value="admin">Administrator</option></select></td><td>{{u.isActive?'Active':'Disabled'}}</td><td>{{u.lastLoginAt||'Never'}}</td><td><button class="btn btn-sm" (click)="update(u,{isActive:!u.isActive})">{{u.isActive?'Disable':'Enable'}}</button><button class="btn btn-sm" (click)="reset(u)">Reset password</button></td></tr>}</tbody></table></div>}@else{<p class="empty">No users found.</p>}</section>
`,styles:`.form{padding:16px;margin-bottom:15px}.form h2{font:600 18px var(--font-serif);margin-bottom:12px}.fields{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.fields label{display:grid;gap:4px;font-size:12px;min-width:150px}.name{min-width:140px}.empty{padding:30px}`})
export class UsersPage {
 private readonly api=inject(ApiService).api;protected readonly users=signal<UserDto[]>([]);protected readonly error=signal('');
 protected username='';protected displayName='';protected role:Role='cashier';protected password='';
 constructor(){void this.load();}private async load(){try{this.users.set(await this.api.auth.listUsers());}catch(e){this.error.set(messageOf(e));}}
 protected async create(){try{const u=await this.api.auth.createUser({username:this.username,displayName:this.displayName,role:this.role,password:this.password});this.users.update(rows=>[...rows,u]);this.username='';this.displayName='';this.password='';}catch(e){this.error.set(messageOf(e));}}
 protected async update(u:UserDto,patch:{displayName?:string;role?:Role;isActive?:boolean}){try{const updated=await this.api.auth.updateUser({id:u.id,displayName:patch.displayName??u.displayName,role:patch.role??u.role,isActive:patch.isActive??u.isActive});this.users.update(rows=>rows.map(x=>x.id===u.id?updated:x));}catch(e){this.error.set(messageOf(e));}}
 protected async reset(u:UserDto){const pw=window.prompt(`New password for ${u.username}:`);if(!pw)return;try{await this.api.auth.resetPassword({id:u.id,newPassword:pw});}catch(e){this.error.set(messageOf(e));}}
}
