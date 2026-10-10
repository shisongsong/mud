import type { IdGenerator } from "../../kernel/ports.ts";
import type {
  QueryAggregate,
  SettlementConfirmation,
} from "../../modules/query/public.ts";
import type { PostgresBoardCommands } from "./board-commands.ts";
import type { PostgresPlayerCommands } from "./player-commands.ts";
import type { PostgresQueryCommands } from "./query-commands.ts";
import type { PostgresQueryRepository } from "./query-repository.ts";
import type { PostgresScriptCommands } from "./script-commands.ts";

const SETTLEMENT_BATCH_LIMIT = 20;

export class QuerySettlementCoordinator {
  constructor(
    private readonly queries: Pick<
      PostgresQueryRepository,
      "listSettlingQueryIds" | "get" | "getSettlementConfirmations"
    >,
    private readonly queryCommands: Pick<
      PostgresQueryCommands,
      "confirmSettlementEffects" | "finalizeSettlement"
    >,
    private readonly boardCommands: Pick<PostgresBoardCommands, "applyDelta">,
    private readonly playerCommands: Pick<
      PostgresPlayerCommands,
      "applyScoreEffect"
    >,
    private readonly scriptCommands: Pick<
      PostgresScriptCommands,
      "createQueryCardScript" | "grantKnowledgeEffect"
    >,
    private readonly idGenerator: IdGenerator,
    private readonly onError: (queryId: string, error: unknown) => void,
  ) {}

  async advanceDueSettlements(limit = SETTLEMENT_BATCH_LIMIT): Promise<number> {
    const queryIds = await this.queries.listSettlingQueryIds(limit);
    let completed = 0;
    for (const queryId of queryIds) {
      try {
        if (await this.settle(queryId)) completed += 1;
      } catch (error: unknown) {
        this.onError(queryId, error);
      }
    }
    return completed;
  }

  private async settle(queryId: string): Promise<boolean> {
    const query = await this.queries.get(queryId);
    if (query?.phase !== "settling" || query.settlementPlan === null) {
      return false;
    }

    const plan = query.settlementPlan;
    const traceId = this.idGenerator.next();
    const confirmed = new Map(
      (await this.queries.getSettlementConfirmations(queryId)).map(
        ({ effectKey, resultReference }) => [effectKey, resultReference],
      ),
    );

    for (const effectKey of plan.targets) {
      if (confirmed.has(effectKey)) continue;
      const resultReference = await this.applyEffect(query, effectKey, traceId);
      await this.queryCommands.confirmSettlementEffects(queryId, [
        { effectKey, resultReference },
      ]);
      confirmed.set(effectKey, resultReference);
    }

    const confirmations: SettlementConfirmation[] = [...confirmed].map(
      ([effectKey, resultReference]) => ({
        effectKey,
        resultReference,
      }),
    );
    await this.queryCommands.finalizeSettlement(
      queryId,
      confirmations,
      traceId,
    );
    return true;
  }

  private async applyEffect(
    query: QueryAggregate,
    effectKey: string,
    traceId: string,
  ): Promise<string> {
    const plan = query.settlementPlan;
    if (plan === null) throw new Error("Settlement plan is unavailable");

    if (effectKey === `board:${query.queryId}`) {
      const applied = await this.boardCommands.applyDelta(
        effectKey,
        plan.boardDelta,
        plan.settlementId,
      );
      return applied.resultReference;
    }

    const pointAward = plan.pointAwards.find(
      ({ playerId }) => effectKey === `points:${query.queryId}:${playerId}`,
    );
    if (pointAward) {
      const applied = await this.playerCommands.applyScoreEffect(
        effectKey,
        pointAward.playerId,
        pointAward.requestedDelta,
        plan.settlementId,
        traceId,
      );
      return `player-score:${applied.effect.effectId}:${applied.effect.aggregateVersion}`;
    }

    const action = query.actions.find(
      ({ card }) => effectKey === `knowledge:${query.queryId}:${card.cardId}`,
    );
    if (action) {
      const script = await this.scriptCommands.createQueryCardScript(
        `script-create:${query.queryId}:${action.card.cardId}`,
        {
          queryId: query.queryId,
          playerId: action.playerId,
          cardId: action.card.cardId,
          contentText: action.card.text,
          gameplayReleaseId: query.gameplayReleaseId,
        },
        traceId,
      );
      const grant = await this.scriptCommands.grantKnowledgeEffect(
        effectKey,
        script.scriptId,
        action.playerId,
        `query:${query.queryId}:card:${action.card.cardId}`,
        traceId,
      );
      return `knowledge-grant:${grant.grantId}`;
    }

    throw new Error(`Settlement target is not present in its fixed plan`);
  }
}
