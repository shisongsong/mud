export interface MaintenanceTask {
  readonly name: string;
  readonly run: () => Promise<unknown>;
}

export interface MaintenanceOptions {
  readonly tasks: readonly MaintenanceTask[];
  readonly intervalMs: number;
  readonly onError: (taskName: string, error: unknown) => void;
}

/**
 * Runs maintenance tasks on a fixed interval. A tick never overlaps the
 * previous one in this process, and a failing task does not prevent the
 * remaining tasks from running. Returns a stop function that clears the timer
 * and resolves once any in-flight tick has finished.
 */
export function startMaintenance(
  options: MaintenanceOptions,
): () => Promise<void> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new TypeError("Maintenance interval must be a positive integer");
  }

  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const runTick = async (): Promise<void> => {
    for (const task of options.tasks) {
      try {
        await task.run();
      } catch (error: unknown) {
        options.onError(task.name, error);
      }
    }
  };

  const tick = (): void => {
    if (stopped || inFlight !== null) return;
    inFlight = runTick().finally(() => {
      inFlight = null;
    });
  };

  const timer = setInterval(tick, options.intervalMs);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    if (inFlight !== null) await inFlight;
  };
}
