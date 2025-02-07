export type AsyncSupplier<T> = () => Promise<T>;

export class StateCache<T> {
  private state?: T;
  private lastCheck = new Date('2000-01-02');
  private pendingUpdates = 0;

  constructor(
    private readonly cacheTime: number = 5_000,
  ) {
    this.update = this.update.bind(this);
    this.getIfNotExpired = this.getIfNotExpired.bind(this);
    this.lockForUpdate = this.lockForUpdate.bind(this);
    this.release = this.release.bind(this);
    this.getOrUpdate = this.getOrUpdate.bind(this);
  }

  update(newState: T) {
    this.state = newState;
    this.lastCheck = new Date();
  }

  private lockForUpdate(): number {
    const pending = this.pendingUpdates;
    this.pendingUpdates += 1;
    // There MAY be race condition but whatever, it's just smart home.
    // If, for some reason, we allow for two simultaneous updates, then screw it, it's not gonna break anything.
    return pending;
  }

  private release() {
    this.pendingUpdates -= 1;
  }

  invalidate() {
    this.lastCheck = new Date('2000-01-02');
  }

  bumpExpiration() {
    this.lastCheck = new Date();
  }

  async getOrUpdate(supplier: AsyncSupplier<T>, defaultValue: T): Promise<T> {
    const placeInQueue = this.lockForUpdate();

    const value = this.getIfNotExpired();
    if (value) {
      this.release();
      return value;
    }
    if (placeInQueue > 0) {
      this.release();
      return this.state || defaultValue;
    }

    try {
      const newValue = await supplier();
      this.update(newValue);
      return newValue;
    } finally {
      this.release();
    }
  }

  getIfNotExpired(): T | undefined {
    if ((new Date().getTime() - this.lastCheck.getTime()) < this.cacheTime) {
      return this.state || undefined;
    } else {
      return undefined;
    }
  }
}