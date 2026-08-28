/**
 * Waiting for something that might never finish, without abandoning it.
 *
 * `Promise.race([work(), timeout])` reads like a budget and is not one. The race settles; the work
 * does not stop. It keeps writing into whatever it was collecting while the caller is already
 * reading the results, and if it fails after the race has been decided the rejection has nowhere to
 * go - which in Node ends the whole process rather than the one case that timed out.
 *
 * So the promise is held rather than dropped, its outcome is absorbed here, and the caller is told
 * whether it actually finished. Then a timeout can do the two things a timeout is for: cancel the
 * work at the source, and wait a bounded moment for the reader to notice.
 */
export function settledWithin(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  // Either outcome is settled. Handling the rejection here is the point: a promise nobody catches
  // is the failure mode this function exists to remove, not one to reintroduce.
  const done = Promise.resolve(promise).then(
    () => true,
    () => true,
  );
  return Promise.race([done, expired]).finally(() => clearTimeout(timer));
}
