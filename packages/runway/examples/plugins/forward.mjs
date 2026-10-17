// This example routes real requests through a managed plugin without replacing
// test resources, assertions, or upstream response bodies.
export default function ({ controller: { ManagedPlugin } }) {
  const requests = [];
  const workers = [];
  class ForwardPlugin extends ManagedPlugin {
    constructor() {
      super("runway-forward", []);
    }
    install(frame) {
      super.install(frame);
      this.tap(
        frame.hooks.fetch.request,
        async ({ client, request, parsed }, props) => {
          if (props.earlyResponse) return;
          props.earlyResponse = await client.fetch(props.url, props.init);
          requests.push(props.url.href);
          if (
            parsed.destination === "worker" ||
            parsed.destination === "sharedworker"
          ) {
            workers.push({
              url: props.url.href,
              destination: request.rawDestination,
              mode: request.mode,
              credentials: request.rawCredentials,
              isModule: parsed.isModule,
            });
          }
        },
      );
      return undefined;
    }
  }
  return {
    plugins: [new ForwardPlugin()],
    report: () => ({
      routedRequests: requests.length,
      urls: requests,
      workers,
    }),
    verify({ testURL }) {
      const withoutFragment = (url) => {
        const parsed = new URL(url);
        parsed.hash = "";
        return parsed.href;
      };
      if (
        !requests.length ||
        (testURL &&
          !requests.some(
            (url) => withoutFragment(url) === withoutFragment(testURL),
          ))
      ) {
        throw new Error(
          "The forwarding plugin did not route the tested document",
        );
      }
      return undefined;
    },
  };
}
