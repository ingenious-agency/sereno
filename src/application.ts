import { Context, Data, Effect, Layer, Ref, Semaphore } from "effect";
import {
  buildTree,
  emptyTree,
  planAction,
  type ActionPlan,
  type Execution,
  type Organization,
  type ProviderSnapshot,
  type Tree,
} from "./domain.ts";

export class ApplicationError extends Data.TaggedError("ApplicationError")<{ message: string }> {}
export const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new ApplicationError({ message: error instanceof Error ? error.message : String(error) }),
  });
export interface InventoryProvider {
  id: string;
  read: Effect.Effect<ProviderSnapshot, ApplicationError>;
}
export class InventoryProviders extends Context.Service<
  InventoryProviders,
  { providers: InventoryProvider[] }
>()("sereno/InventoryProviders") {}
export class OrganizationRepository extends Context.Service<
  OrganizationRepository,
  {
    load: Effect.Effect<Organization, ApplicationError>;
    save: (organization: Organization) => Effect.Effect<void, ApplicationError>;
  }
>()("sereno/OrganizationRepository") {}
export interface ActionOutput {
  text: string;
  successful: boolean;
}
export class ActionExecutor extends Context.Service<
  ActionExecutor,
  { execute: (execution: Execution) => Effect.Effect<ActionOutput, ApplicationError> }
>()("sereno/ActionExecutor") {}
export class Application extends Context.Service<
  Application,
  {
    snapshot: Effect.Effect<Tree>;
    refresh: Effect.Effect<Tree, ApplicationError>;
    organize: (
      change: (organization: Organization, tree: Tree) => Organization,
    ) => Effect.Effect<Tree, ApplicationError>;
    preview: (nodeId: string, actionId: string) => Effect.Effect<ActionPlan, ApplicationError>;
    execute: (
      plan: ActionPlan,
      confirmed: boolean,
    ) => Effect.Effect<ActionOutput, ApplicationError>;
  }
>()("sereno/Application") {}

/** Application policy lives here; IO is supplied by layers at the composition root. */
export const ApplicationLive = Layer.effect(
  Application,
  Effect.gen(function* () {
    const inventories = yield* InventoryProviders,
      repository = yield* OrganizationRepository,
      executor = yield* ActionExecutor;
    const organization = yield* Ref.make(yield* repository.load);
    const snapshots = yield* Ref.make<ProviderSnapshot[]>([]),
      tree = yield* Ref.make(emptyTree());
    const mutation = yield* Semaphore.make(1),
      refreshing = yield* Semaphore.make(1);
    const reconcile = Effect.gen(function* () {
      const sources = yield* Ref.get(snapshots),
        config = yield* Ref.get(organization);
      const result = yield* Effect.try({
        try: () => buildTree(sources, config),
        catch: (error) => new ApplicationError({ message: String(error) }),
      });
      yield* Ref.set(tree, result);
      return result;
    });
    const refresh = refreshing.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* Ref.get(snapshots);
        const next = yield* Effect.forEach(
          inventories.providers,
          (provider) =>
            provider.read.pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  id: provider.id,
                  state: "unavailable" as const,
                  nodes: previous.find((p) => p.id === provider.id)?.nodes ?? [],
                  at: previous.find((p) => p.id === provider.id)?.at,
                  message: error.message,
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        yield* Ref.set(snapshots, next);
        return yield* reconcile;
      }),
    );
    return {
      snapshot: Ref.get(tree),
      refresh,
      organize: (change) =>
        mutation.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(organization),
              currentTree = yield* Ref.get(tree),
              sources = yield* Ref.get(snapshots);
            const next = yield* Effect.try({
              try: () => change(current, currentTree),
              catch: (error) => new ApplicationError({ message: String(error) }),
            });
            const nextTree = yield* Effect.try({
              try: () => buildTree(sources, next),
              catch: (error) => new ApplicationError({ message: String(error) }),
            });
            yield* repository.save(next);
            yield* Ref.set(organization, next);
            yield* Ref.set(tree, nextTree);
            return nextTree;
          }),
        ),
      preview: (nodeId, actionId) =>
        Effect.gen(function* () {
          const current = yield* refresh;
          return yield* Effect.try({
            try: () => planAction(current, nodeId, actionId),
            catch: (error) => new ApplicationError({ message: String(error) }),
          });
        }),
      execute: (plan, confirmed) =>
        mutation.withPermits(1)(
          Effect.gen(function* () {
            if (plan.action.confirm && !confirmed)
              return yield* Effect.fail(
                new ApplicationError({ message: "Confirmation required for this action" }),
              );
            const current = yield* refresh;
            const fresh = yield* Effect.try({
              try: () => planAction(current, plan.nodeId, plan.action.id),
              catch: (error) => new ApplicationError({ message: String(error) }),
            });
            if (fresh.fingerprint !== plan.fingerprint)
              return yield* Effect.fail(
                new ApplicationError({ message: "Action changed; preview it again" }),
              );
            return yield* executor
              .execute(fresh.action.execution)
              .pipe(Effect.ensuring(Effect.ignore(refresh)));
          }),
        ),
    };
  }),
);
