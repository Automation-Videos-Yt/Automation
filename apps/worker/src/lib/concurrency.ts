/**
 * Tiny bounded-concurrency runner. No external deps.
 * Usage: const limit = pLimit(3); await Promise.all(xs.map(x => limit(() => work(x))));
 */
export function pLimit(concurrency: number) {
  if (concurrency < 1) throw new Error("pLimit concurrency must be >= 1");
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    const head = queue.shift();
    if (head) head();
  };

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const exec = () => {
        active++;
        fn().then(
          (v) => {
            resolve(v);
            next();
          },
          (e) => {
            reject(e);
            next();
          }
        );
      };
      if (active < concurrency) exec();
      else queue.push(exec);
    });
  };
}
