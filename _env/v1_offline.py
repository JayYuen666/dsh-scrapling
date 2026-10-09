"""V1: offline verification — pure parser capability, zero network/browser."""

from scrapling.parser import Selector

HTML = """
<html><body>
  <nav>Site Nav</nav>
  <div id="main">
    <h1 class="title">Hello</h1>
    <ul class="list">
      <li class="item" data-id="1">Alpha</li>
      <li class="item" data-id="2">Beta</li>
      <li class="item" data-id="3">Gamma</li>
    </ul>
    <a href="/rel">rel link</a>
  </div>
  <!-- a comment -->
  <script>var x=1;</script>
  <div style="display:none">HIDDEN INJECTION PAYLOAD</div>
  <div aria-hidden="true">ARIA HIDDEN PAYLOAD</div>
  <template>ZERO WIDTH:</template>
  <footer>Footer</footer>
</body></html>
"""

p = Selector(HTML)
print("== basic selection ==")
print("css h1.text        :", p.css("h1.title::text").get())
print("css all items      :", p.css(".item::text").getall())
print("xpath count        :", p.xpath("//li[@class='item']").count)
print("attrib data-id     :", p.css(".item::attr(data-id)").getall())
print("regex on html      :", p.re_first(r'data-id="(\d+)"'))
print("get_all_text       :", repr(p.get_all_text(strip=True))[:120])
print("has_class          :", p.css("ul").has_class("list"))
print("parent chain       :", p.css("li").first.parent.attrib.get("class"))
print("urljoin            :", p.urljoin("/abs"))

print("\n== find_similar / similarity ==")
sim = p.css("li").first.find_similar(similarity_threshold=0.5)
print("similar count      :", sim.count, [s.attrib.get("data-id") for s in sim])

print("\n== Response.markdown() injection sanitization ==")
from scrapling.engines.toolbelt.custom import Response

r = Response(url="http://example.com", content=HTML, status=200, reason="OK",
             cookies={}, headers={}, request_headers={})
md = r.markdown()
print("markdown           :", repr(md)[:220])
print("has HIDDEN payload :", "HIDDEN INJECTION PAYLOAD" in md)
print("has ARIA payload   :", "ARIA HIDDEN PAYLOAD" in md)
print("has script var     :", "var x=1" in md)
print("has comment        :", "a comment" in md)

md_body = r.markdown(main_content_only=True)
print("\n== markdown(main_content_only=True) ==")
print("has HIDDEN payload :", "HIDDEN INJECTION PAYLOAD" in md_body)
print("has ARIA payload   :", "ARIA HIDDEN PAYLOAD" in md_body)
print("has nav/footer     :", "Site Nav" in md_body, "Footer" in md_body)

print("\n== markdown(css_selector) ==")
print(repr(r.markdown(css_selector=".list"))[:160])

print("\n== Selector public API surface ==")
meths = sorted(m for m in dir(Selector) if not m.startswith("_"))
print(len(meths), "public members")
print(meths)