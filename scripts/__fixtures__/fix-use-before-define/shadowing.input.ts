// A nested-scope binding shadows an outer-scope name. The codemod must NOT
// hoist the outer `error` declaration above `runFirst()` based on a
// reference inside `runFirst`'s catch block — that reference resolves to
// the catch-clause's own `error` parameter, not the outer one.
function runFirst() {
  try {
    doWork();
  } catch (error) {
    console.log(error.message);
  }
}

const error = new Error("outer");
export { error, runFirst };
