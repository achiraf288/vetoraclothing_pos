import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EmptyStateComponent } from '../../ui/empty-state.component';

@Component({
  selector: 'app-forbidden',
  imports: [EmptyStateComponent, RouterLink],
  template: `
    <app-empty-state title="You do not have access to this page" message="Ask an administrator if you need it.">
      <a class="btn" routerLink="/pos">Go to point of sale</a>
    </app-empty-state>
  `,
})
export class ForbiddenPage {}
