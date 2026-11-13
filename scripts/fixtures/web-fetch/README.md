# Web fetch test fixtures

Saved page copies used by `scripts/test-reader-foundations.ts`, so extraction tests do not
depend on live network responses. Each file is gzip-compressed and read with
`node:zlib`; decompress one with `gzip -dc file.html.gz` to inspect it.

| File | Source page | Copy |
| --- | --- | --- |
| `iana-http-status-codes.xhtml.gz` | <https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml> | ~39 KB, from the Antigravity live fetch, 2026-10-19 |
| `wikipedia-artemis-ii.html.gz` | <https://en.wikipedia.org/wiki/Artemis_II> | ~172 KB, from the Antigravity live fetch, 2026-10-19; the crawler's own limit cuts it mid-sentence near the end |
| `nasa-artemis-heat-shield.html.gz` | <https://www.nasa.gov/missions/artemis/artemis-2/rigorous-analysis-confirms-nasas-artemis-ii-heat-shield-performance/> | ~292 KB, from the Antigravity live fetch, 2026-10-19 |
| `mdn-status-shell.html.gz` | <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status> | ~26 KB, the crawler's copy: a pre-hydration shell, cut off inside its navigation menu |
| `mdn-status-page.html.gz` | same MDN URL | ~234 KB, fetched with curl and a browser user agent, because that observed crawler copy lacked the article |
| `github-docs-hello-world.html.gz` | <https://docs.github.com/en/get-started/using-github/hello-world> | ~25 KB, the crawler's copy, 2026-10-19: a body-less JavaScript shell cut mid-tag, the article only visible with a browser |
| `rfc9110-excerpt.html.gz` | <https://www.rfc-editor.org/rfc/rfc9110.html> | first 300,000 bytes of the crawler's ~1.2 MB copy, cut at a UTF-8-safe boundary so fixtures stay valid text; big standards page with prose, tables, and fenced examples |
| `python-urllib-request.html.gz` | <https://docs.python.org/3/library/urllib.request.html> | ~29 KB, the crawler's copy, 2026-10-19: ends mid-paragraph; `role="main"` article between navigation sidebars |
| `nist-sp800-53r5.html.gz` | <https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final> | ~57 KB, the crawler's copy, 2026-10-19: a complete page written by a Windows CMS, so text carries `\r\n` line endings |
| `first-website.html.gz` | <http://info.cern.ch/hypertext/WWW/TheProject.html> | ~2.2 KB, the crawler's copy, 2026-10-19; Tim Berners-Lee's 1991 first web page: title-only head, uppercase tags, relative links |
| `tldp-howto.html.gz` | <https://tldp.org/HOWTO/Unix-and-Internet-Fundamentals-HOWTO/> | ~1.9 KB, the crawler's copy, 2026-10-19; 1990s SGML tooling writes `<TD >`-style close tags with interior whitespace, and the copy ends mid-sentence |
| `javadoc-string.html.gz` | <https://docs.oracle.com/javase/8/docs/api/java/lang/String.html> | ~25 KB, the crawler's copy, 2026-10-19; frames-era javadoc with `document.write('<script …>')` inside scripts and a skip-to-navigation link |
| `spacejam.html.gz` | <https://www.spacejam.com/1996/> | ~1.8 KB, the crawler's copy, 2026-10-19; a 1996 layout-table page where the crawler cut off inside a `<tr>`, leaving no readable text |

Every file except `mdn-status-page` is the bytes `read_url_content` actually receives
from the Antigravity fetch RPCs (cache or live), tokens excluded. Each pins a case the
live service really serves: complete modern pages (IANA, NASA, NIST), the crawler's own
truncation (Wikipedia, Python, TLDP, GitHub Docs, Space Jam, and the RFC excerpt), a
JavaScript-only shell (GitHub Docs, and `mdn-status-shell` for the honest partial
result), 1990s markup (first-website, TLDP, javadoc, Space Jam), and prose the
converter once mangled (the RFC's fences, javadoc's script strings). `mdn-status-page`
is the article HTML MDN serves a browser, kept so the converter is still tested against
MDN-authored markup.

These fixture bytes were carried from `origin/main` at `68cdca8`; its separate reader implementation and test suite were not imported. Descriptions above refer to these saved observations, not a promise about what Google returns today.

Replace a fixture only together with the expectations in `scripts/test-reader-foundations.ts`,
and update this table when you do.
