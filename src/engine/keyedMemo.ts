/** Mémoïsation par clé : la valeur n'est recalculée que si la clé change. */
export class KeyedMemo<T> {
  private key: string | null = null;
  private value: T | undefined;

  get(key: string, build: () => T): T {
    if (key !== this.key || this.value === undefined) {
      this.key = key;
      this.value = build();
    }
    return this.value;
  }
}
