# js/vendor

Third-party code served from this repository instead of a CDN, so that nothing outside the
app's own origin runs in the page that holds the OAuth token and the API key.

## heic-to.js

- Source: npm package [`heic-to`](https://www.npmjs.com/package/heic-to) **1.6.7**
  (<https://github.com/hoppergee/heic-to>), file `dist/csp/heic-to.js` copied unmodified
  (the CSP build: no `eval` / `new Function`; it decodes in a Worker created from a `blob:` URL).
- SHA-256: `e0a515585872c319c601c33551925c9d5fee31746caf0311291ed7e6364c592c`
- License: LGPL-3.0 (it bundles libheif / libde265). Full text in `heic-to.LICENSE.txt`; the LGPL
  supplements the GNU GPL v3, <https://www.gnu.org/licenses/gpl-3.0.txt>. The corresponding source
  is in the npm package (`src/`) and the upstream repository.
- Used by `js/loader.js` (`HEIC_TO_SRC`), imported lazily only when the browser cannot decode a
  HEIC photo itself. The app calls `heicTo({ blob, type: 'image/jpeg', quality })`; the module also
  exports `isHeic`.

### Updating

```sh
npm pack heic-to@<version>                 # in a scratch directory, not in this repo
tar xzf heic-to-<version>.tgz
cp package/dist/csp/heic-to.js   <repo>/js/vendor/heic-to.js
cp package/LICENSE               <repo>/js/vendor/heic-to.LICENSE.txt
sha256sum <repo>/js/vendor/heic-to.js      # update the hash and version above
```

Check that the build still exports `heicTo` with the same options, then run the
HEIC E2E test (`node --test --test-concurrency=1 tests/e2e/06-media-mobile.test.mjs`).
