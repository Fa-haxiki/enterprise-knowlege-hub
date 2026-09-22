import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { MemoryModule } from '../memory/memory.module';
import { GraphModule } from '../graph/graph.module';
import { WebSearchService } from './tools/web-search.service';

@Module({
  imports: [WorkspacesModule, RetrievalModule, MemoryModule, GraphModule],
  providers: [AgentService, WebSearchService],
  exports: [AgentService],
})
export class AgentsModule {}
