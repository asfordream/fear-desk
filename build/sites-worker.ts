import handler from "vinext/server/fetch-handler";
import {runWithExecutionContext} from 'vinext/shims/request-context';
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import {admitScheduled,drainJob,originalScheduledDelivery} from '../lib/daily-pipeline';
import {DailyRepository} from '../lib/daily-repository';

export default {
  async scheduled(controller:ScheduledController,env:Cloudflare.Env) {
    const repo=new DailyRepository(),accepted=await admitScheduled(env,repo,new Date(controller.scheduledTime));
    if('job' in accepted){await drainJob(accepted.job.id,repo,env);await originalScheduledDelivery(accepted.requestId,env,repo);}
  },
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithExecutionContext(ctx, () => runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx)));
  },
};
