import { querySnapshotResponseSchema } from "../../contracts/http.ts";
import type { QuerySnapshotResponse } from "../../contracts/http.ts";
import type { PlayerActor } from "../../kernel/actor.ts";
import type { Clock } from "../../kernel/ports.ts";
import { getAuthorizedQueryView } from "../../modules/query/public.ts";
import type { UnitOfWork } from "../transactions/unit-of-work.ts";
import type { GameplayReleaseReader } from "./gameplay-release-repository.ts";
import { PostgresPlayerRepository } from "./player-repository.ts";
import { PostgresQueryRepository } from "./query-repository.ts";

export class PostgresQueryViews {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: PostgresQueryRepository,
    private readonly players: PostgresPlayerRepository,
    private readonly clock: Clock,
    private readonly gameplayReleases: GameplayReleaseReader,
  ) {}

  /**
   * Returns the caller's private snapshot. Unknown rooms and non-members both
   * yield null so that room existence is not disclosed to outsiders.
   */
  async getSnapshot(
    actor: PlayerActor,
    queryId: string,
  ): Promise<QuerySnapshotResponse | null> {
    const serverTime = this.clock.now();
    return this.unitOfWork.transaction(async (transaction) => {
      const query = await this.repository.getInTransaction(
        transaction,
        queryId,
      );
      if (query === null) return null;
      if (
        !query.participants.some(
          (participant) => participant.playerId === actor.playerId,
        )
      ) {
        return null;
      }

      const view = getAuthorizedQueryView(query, actor.playerId);
      const participants: { displayName: string; isSelf: boolean }[] = [];
      for (const participant of query.participants) {
        const displayName = await this.players.getDisplayNameByPlayerId(
          transaction,
          participant.playerId,
        );
        if (displayName === null) {
          throw new Error("Query participant has no player profile");
        }
        participants.push({
          displayName,
          isSelf: participant.playerId === actor.playerId,
        });
      }

      let result = null;
      if (query.phase === "completed") {
        const scenario = query.scenario;
        const plan = query.settlementPlan;
        if (scenario === null || plan === null) {
          throw new Error("Completed query is missing its pinned settlement");
        }
        const release = await this.gameplayReleases.getGameplayReleaseById(
          transaction,
          query.gameplayReleaseId,
        );
        const variant = release?.trial1?.variants.find(
          ({ variantId }) => variantId === scenario.variantId,
        );
        if (!variant) {
          throw new Error("Completed query has no pinned explanation");
        }
        const scoreEffect = await this.players.getScoreEffectInTransaction(
          transaction,
          `points:${query.queryId}:${actor.playerId}`,
          actor.playerId,
        );
        if (!scoreEffect) {
          throw new Error("Completed query has no participant score effect");
        }
        const choice1 = query.votes.filter(
          ({ choice }) => choice === "choice_1",
        ).length;
        const choice2 = query.votes.filter(
          ({ choice }) => choice === "choice_2",
        ).length;
        const abstentions = query.votes.filter(
          ({ choice }) => choice === "abstain",
        ).length;
        result = {
          selectedChoice: query.selectedChoice,
          correctChoice: scenario.correctChoice,
          voteCounts: {
            choice1,
            choice2,
            abstentions,
            notCast: query.participants.length - query.votes.length,
          },
          explanationKey: variant.explanationKey,
          ownScore: {
            requestedDelta: scoreEffect.requestedDelta,
            awardedDelta: scoreEffect.effectiveDelta,
            scoreAfter: scoreEffect.scoreAfter,
          },
        };
      }

      return querySnapshotResponseSchema.parse({
        queryId: view.queryId,
        phase: view.phase,
        deadline:
          view.deadline === null ? null : new Date(view.deadline).toISOString(),
        serverTime: serverTime.toISOString(),
        gameplayReleaseId: view.gameplayReleaseId,
        aggregateVersion: view.version,
        participants,
        self: {
          actionsUsed: view.ownActionsUsed,
          voteChoice: view.ownVote,
          evidenceCards: view.ownEvidenceCards.map((card) => ({
            cardId: card.cardId,
            siteId: card.siteId,
            text: card.text,
          })),
        },
        result,
      });
    });
  }
}
