import { DatabaseModule, LoggerModule } from '@app/common';
import { Module } from '@nestjs/common';
import { TeamsController } from './teams.controller';
import { InvitesController } from './invites.controller';
import { TeamsService } from './teams.service';
import { TeamsRepository } from './teams.repository';
import { TeamMembersRepository } from './team-members.repository';
import { TeamInvitesRepository } from './team-invites.repository';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';
import { TeamInvite } from './entities/team-invite.entity';

@Module({
  imports: [
    DatabaseModule.forFeature([Team, TeamMember, TeamInvite]),
    LoggerModule,
  ],
  controllers: [TeamsController, InvitesController],
  providers: [
    TeamsService,
    TeamsRepository,
    TeamMembersRepository,
    TeamInvitesRepository,
  ],
  // Cars and sessions scope their queries through these primitives.
  exports: [TeamsService],
})
export class TeamsModule {}
