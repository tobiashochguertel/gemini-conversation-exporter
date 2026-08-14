/**
 * Generic paginated history fetcher.
 *
 * Implements the common flow for fetching paginated conversation history
 * from a web app's internal RPC endpoint:
 *
 *   1. Get site config (auth tokens, etc.)
 *   2. Build query parameters
 *   3. Build request body
 *   4. Build the endpoint URL
 *   5. Build fetch options (with cross-realm cloning for Firefox)
 *   6. Execute the fetch
 *   7. Validate the response
 *
 * Site-specific behavior is injected via an adapter object that provides:
 *
 *   - pageWindow:     the window object to fetch from
 *   - getConfig():    returns site-specific auth/config values
 *   - buildQuery(config, cursor):  returns URLSearchParams for the query string
 *   - buildBody(config, cursor):   returns a string (URL-encoded body)
 *   - buildEndpoint(query):        returns the full request URL string
 *   - buildFetchOptions(body):     returns the fetch options object
 *     (the fetcher handles cloneForPageRealm internally)
 */

const HistoryFetcher = Object.freeze({
  /**
   * Fetch a single page of conversation history.
   *
   * @param {object} adapter - Site-specific adapter (see module docs).
   * @param {string|null} cursor - Pagination cursor from the previous page, or null for the first page.
   * @returns {Promise<string>} Raw response text from the RPC endpoint.
   * @throws {Error} If the fetch fails or the response is not OK.
   */
  async fetchPage(adapter, cursor) {
    const config = adapter.getConfig();
    const query = adapter.buildQuery(config, cursor);
    const body = adapter.buildBody(config, cursor);
    const endpoint = adapter.buildEndpoint(query);
    const requestOptions = Utils.cloneForPageRealm(
      adapter.buildFetchOptions(body),
      adapter.pageWindow,
    );

    const response = await adapter.pageWindow.fetch(endpoint, requestOptions);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `History request failed with HTTP ${response.status}.`,
      );
    }

    return text;
  },
});
