// Vibrato native web view: WKWebView instances placed inside an Electron window's content view.
// N-API only (no node-addon-api), so one build works for any Electron version.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#include <node_api.h>
#include <string>
#include <unordered_map>

static napi_threadsafe_function g_events = nullptr;   // JS event handler (JSON strings)
static napi_threadsafe_function g_done = nullptr;     // promise completions
static int g_next_id = 1;

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, nullptr, #call " failed"); return nullptr; } } while (0)

// ---------- events ----------

static void call_event(napi_env env, napi_value js_cb, void*, void* data) {
  std::string* s = static_cast<std::string*>(data);
  if (env && js_cb) {
    napi_value arg, undef;
    napi_create_string_utf8(env, s->c_str(), s->size(), &arg);
    napi_get_undefined(env, &undef);
    napi_call_function(env, undef, js_cb, 1, &arg, nullptr);
  }
  delete s;
}

static void emit(NSDictionary* payload) {
  if (!g_events) return;
  NSData* json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (!json) return;
  auto* s = new std::string((const char*)json.bytes, json.length);
  if (napi_call_threadsafe_function(g_events, s, napi_tsfn_nonblocking) != napi_ok) delete s;
}

// ---------- promise completions ----------

struct Completion {
  napi_deferred deferred;
  bool ok;
  std::string text;      // JSON value or error message
  NSData* __strong png;  // snapshot result
};

static void call_done(napi_env env, napi_value, void*, void* data) {
  Completion* c = static_cast<Completion*>(data);
  if (env) {
    napi_value v;
    if (!c->ok) {
      napi_value msg;
      napi_create_string_utf8(env, c->text.c_str(), c->text.size(), &msg);
      napi_create_error(env, nullptr, msg, &v);
      napi_reject_deferred(env, c->deferred, v);
    } else if (c->png) {
      void* out;
      napi_create_buffer_copy(env, c->png.length, c->png.bytes, &out, &v);
      napi_resolve_deferred(env, c->deferred, v);
    } else {
      napi_create_string_utf8(env, c->text.c_str(), c->text.size(), &v);
      napi_resolve_deferred(env, c->deferred, v);
    }
  }
  delete c;
}

static void finish(Completion* c) {
  if (!g_done || napi_call_threadsafe_function(g_done, c, napi_tsfn_nonblocking) != napi_ok) delete c;
}

// ---------- web view host ----------

@class VBHost;
struct Entry { WKWebView* __strong web; VBHost* __strong host; };
static std::unordered_map<int, Entry> g_views;

static NSString* g_userAgent = nil; // one user agent for every view, popups included

@interface VBHost : NSObject <WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property(nonatomic) int vid;
@property(nonatomic, weak) WKWebView* web;
@end

static int adopt(WKWebView* web, int openerId);

@implementation VBHost
- (void)observeValueForKeyPath:(NSString*)key ofObject:(id)obj change:(NSDictionary*)change context:(void*)ctx {
  WKWebView* w = self.web;
  if (!w) return;
  emit(@{ @"type": @"state", @"id": @(self.vid), @"url": w.URL.absoluteString ?: @"", @"title": w.title ?: @"",
          @"loading": @(w.isLoading), @"canGoBack": @(w.canGoBack), @"canGoForward": @(w.canGoForward),
          @"progress": @(w.estimatedProgress) });
}
- (void)webView:(WKWebView*)w didCommitNavigation:(WKNavigation*)n {
  emit(@{ @"type": @"navigated", @"id": @(self.vid), @"url": w.URL.absoluteString ?: @"" });
}
- (void)webView:(WKWebView*)w didFinishNavigation:(WKNavigation*)n {
  emit(@{ @"type": @"loaded", @"id": @(self.vid), @"url": w.URL.absoluteString ?: @"" });
}
- (void)webView:(WKWebView*)w didFailProvisionalNavigation:(WKNavigation*)n withError:(NSError*)e {
  emit(@{ @"type": @"failed", @"id": @(self.vid), @"error": e.localizedDescription ?: @"", @"code": @(e.code),
          @"url": e.userInfo[NSURLErrorFailingURLStringErrorKey] ?: @"" });
}
- (void)webView:(WKWebView*)w didFailNavigation:(WKNavigation*)n withError:(NSError*)e {
  emit(@{ @"type": @"failed", @"id": @(self.vid), @"error": e.localizedDescription ?: @"", @"code": @(e.code), @"url": w.URL.absoluteString ?: @"" });
}
- (void)webView:(WKWebView*)w decidePolicyForNavigationResponse:(WKNavigationResponse*)r decisionHandler:(void (^)(WKNavigationResponsePolicy))h {
  NSHTTPURLResponse* http = [r.response isKindOfClass:NSHTTPURLResponse.class] ? (NSHTTPURLResponse*)r.response : nil;
  emit(@{ @"type": @"response", @"id": @(self.vid), @"url": r.response.URL.absoluteString ?: @"", @"status": @(http ? http.statusCode : 0),
          @"mime": r.response.MIMEType ?: @"", @"mainFrame": @(r.isForMainFrame) });
  h(WKNavigationResponsePolicyAllow);
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView*)w {
  emit(@{ @"type": @"crashed", @"id": @(self.vid) });
}
// window.open: WebKit hands us the configuration to use; the new view keeps window.opener.
- (WKWebView*)webView:(WKWebView*)w createWebViewWithConfiguration:(WKWebViewConfiguration*)c forNavigationAction:(WKNavigationAction*)a windowFeatures:(WKWindowFeatures*)f {
  WKWebView* child = [[WKWebView alloc] initWithFrame:w.frame configuration:c];
  child.hidden = YES;
  [w.superview addSubview:child positioned:NSWindowAbove relativeTo:w];
  int cid = adopt(child, self.vid);
  emit(@{ @"type": @"popup", @"id": @(cid), @"opener": @(self.vid), @"url": a.request.URL.absoluteString ?: @"" });
  return child;
}
- (void)webViewDidClose:(WKWebView*)w {
  emit(@{ @"type": @"closed", @"id": @(self.vid) });
}
- (void)userContentController:(WKUserContentController*)u didReceiveScriptMessage:(WKScriptMessage*)m {
  id body = m.body;
  if (![NSJSONSerialization isValidJSONObject:@[ body ?: NSNull.null ]]) return;
  emit(@{ @"type": @"message", @"id": @(self.vid), @"body": body ?: NSNull.null });
}
// alert/confirm/prompt: answered right away so pages never block; the app is told.
- (void)webView:(WKWebView*)w runJavaScriptAlertPanelWithMessage:(NSString*)msg initiatedByFrame:(WKFrameInfo*)fr completionHandler:(void (^)(void))h {
  emit(@{ @"type": @"dialog", @"id": @(self.vid), @"kind": @"alert", @"message": msg ?: @"" }); h();
}
- (void)webView:(WKWebView*)w runJavaScriptConfirmPanelWithMessage:(NSString*)msg initiatedByFrame:(WKFrameInfo*)fr completionHandler:(void (^)(BOOL))h {
  emit(@{ @"type": @"dialog", @"id": @(self.vid), @"kind": @"confirm", @"message": msg ?: @"" }); h(YES);
}
- (void)webView:(WKWebView*)w runJavaScriptTextInputPanelWithPrompt:(NSString*)p defaultText:(NSString*)d initiatedByFrame:(WKFrameInfo*)fr completionHandler:(void (^)(NSString*))h {
  emit(@{ @"type": @"dialog", @"id": @(self.vid), @"kind": @"prompt", @"message": p ?: @"" }); h(d);
}
@end

static NSArray<NSString*>* kObserved = @[ @"URL", @"title", @"loading", @"canGoBack", @"canGoForward", @"estimatedProgress" ];

static int adopt(WKWebView* web, int openerId) {
  int vid = g_next_id++;
  VBHost* host = [VBHost new];
  host.vid = vid; host.web = web;
  web.navigationDelegate = host; web.UIDelegate = host;
  if (g_userAgent) web.customUserAgent = g_userAgent;
  if (@available(macOS 13.3, *)) web.inspectable = YES;
  // Keep rendering, rAF and timers running while the window is covered: agents drive pages the user is not looking at.
  SEL occlusion = NSSelectorFromString(@"_setWindowOcclusionDetectionEnabled:");
  if ([web respondsToSelector:occlusion]) ((void (*)(id, SEL, BOOL))objc_msgSend)(web, occlusion, NO);
  for (NSString* k in kObserved) [web addObserver:host forKeyPath:k options:0 context:nullptr];
  g_views[vid] = Entry{ web, host };
  return vid;
}

static WKWebView* viewFor(int vid) {
  auto it = g_views.find(vid);
  return it == g_views.end() ? nil : it->second.web;
}

// ---------- argument helpers ----------

static std::string str_arg(napi_env env, napi_value v) {
  size_t len = 0; napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  std::string s(len, '\0'); napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
  return s;
}
static NSString* ns(const std::string& s) { return [[NSString alloc] initWithBytes:s.data() length:s.size() encoding:NSUTF8StringEncoding] ?: @""; }
static double num_arg(napi_env env, napi_value v) { double d = 0; napi_get_value_double(env, v, &d); return d; }
static bool bool_arg(napi_env env, napi_value v) { bool b = false; napi_get_value_bool(env, v, &b); return b; }
static napi_value prop(napi_env env, napi_value obj, const char* key) {
  bool has = false; napi_has_named_property(env, obj, key, &has);
  if (!has) return nullptr;
  napi_value v; napi_get_named_property(env, obj, key, &v);
  napi_valuetype t; napi_typeof(env, v, &t);
  return (t == napi_undefined || t == napi_null) ? nullptr : v;
}
static napi_value undef(napi_env env) { napi_value u; napi_get_undefined(env, &u); return u; }

#define ARGS(n) size_t argc = n; napi_value argv[n]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr)
#define VIEW_OR_THROW(idx) WKWebView* web = viewFor((int)num_arg(env, argv[idx])); if (!web) { napi_throw_error(env, nullptr, "no such view"); return nullptr; }

// ---------- exported functions ----------

// setEventHandler(fn)
static napi_value SetEventHandler(napi_env env, napi_callback_info info) {
  ARGS(1);
  if (g_events) { napi_release_threadsafe_function(g_events, napi_tsfn_abort); g_events = nullptr; }
  napi_value name; napi_create_string_utf8(env, "vibrato-webview-events", NAPI_AUTO_LENGTH, &name);
  CHECK(napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, call_event, &g_events));
  napi_unref_threadsafe_function(env, g_events);
  return undef(env);
}

// create(parentHandle: Buffer, opts: { userAgent?, storeId?, pageScript?, isolatedScript? }) -> id
static napi_value Create(napi_env env, napi_callback_info info) {
  ARGS(2);
  void* data; size_t len;
  CHECK(napi_get_buffer_info(env, argv[0], &data, &len));
  if (len < sizeof(void*)) { napi_throw_error(env, nullptr, "bad window handle"); return nullptr; }
  NSView* parent = (__bridge NSView*)(*reinterpret_cast<void**>(data));
  napi_value opts = argv[1];

  WKWebViewConfiguration* c = [WKWebViewConfiguration new];
  if (napi_value v = prop(env, opts, "storeId")) {
    if (@available(macOS 14.0, *)) {
      NSUUID* uuid = [[NSUUID alloc] initWithUUIDString:ns(str_arg(env, v))];
      if (uuid) c.websiteDataStore = [WKWebsiteDataStore dataStoreForIdentifier:uuid];
    }
  }
  c.preferences.javaScriptCanOpenWindowsAutomatically = YES;
  WKContentWorld* iso = [WKContentWorld worldWithName:@"vibrato"];
  if (napi_value v = prop(env, opts, "pageScript"))
    [c.userContentController addUserScript:[[WKUserScript alloc] initWithSource:ns(str_arg(env, v)) injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO inContentWorld:WKContentWorld.pageWorld]];
  if (napi_value v = prop(env, opts, "isolatedScript"))
    [c.userContentController addUserScript:[[WKUserScript alloc] initWithSource:ns(str_arg(env, v)) injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO inContentWorld:iso]];
  if (napi_value v = prop(env, opts, "userAgent")) g_userAgent = ns(str_arg(env, v));

  WKWebView* web = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10) configuration:c];
  web.hidden = YES;
  web.allowsBackForwardNavigationGestures = YES;
  web.allowsMagnification = YES;
  [parent addSubview:web positioned:NSWindowAbove relativeTo:nil];
  int vid = adopt(web, 0);
  // The handler lives only in the isolated world, so pages cannot see window.webkit.messageHandlers.vibrato.
  [c.userContentController addScriptMessageHandler:g_views[vid].host contentWorld:iso name:@"vibrato"];
  napi_value out; napi_create_int32(env, vid, &out);
  return out;
}

// destroy(id)
static napi_value Destroy(napi_env env, napi_callback_info info) {
  ARGS(1);
  int vid = (int)num_arg(env, argv[0]);
  auto it = g_views.find(vid);
  if (it == g_views.end()) return undef(env);
  WKWebView* web = it->second.web;
  for (NSString* k in kObserved) [web removeObserver:it->second.host forKeyPath:k];
  [web.configuration.userContentController removeAllScriptMessageHandlers];
  [web stopLoading];
  web.navigationDelegate = nil; web.UIDelegate = nil;
  [web removeFromSuperview];
  g_views.erase(it);
  return undef(env);
}

// setFrame(id, x, y, w, h): top-left based, in points, relative to the window's content view.
static napi_value SetFrame(napi_env env, napi_callback_info info) {
  ARGS(5);
  VIEW_OR_THROW(0);
  double x = num_arg(env, argv[1]), y = num_arg(env, argv[2]), w = num_arg(env, argv[3]), h = num_arg(env, argv[4]);
  NSView* parent = web.superview;
  double top = parent.isFlipped ? y : parent.bounds.size.height - y - h;
  web.autoresizingMask = parent.isFlipped ? NSViewNotSizable : NSViewMinYMargin; // keep the top edge during window resizes
  web.frame = NSMakeRect(x, top, w, h);
  return undef(env);
}

// setVisible(id, visible)
static napi_value SetVisible(napi_env env, napi_callback_info info) {
  ARGS(2);
  VIEW_OR_THROW(0);
  bool visible = bool_arg(env, argv[1]);
  web.hidden = !visible;
  if (visible) [web.superview addSubview:web positioned:NSWindowAbove relativeTo:nil]; // stay above the Electron view
  else if (web.window.firstResponder == web || ([web.window.firstResponder isKindOfClass:NSView.class] && [(NSView*)web.window.firstResponder isDescendantOf:web]))
    [web.window makeFirstResponder:web.superview];
  return undef(env);
}

// load(id, url)
static napi_value Load(napi_env env, napi_callback_info info) {
  ARGS(2);
  VIEW_OR_THROW(0);
  NSURL* url = [NSURL URLWithString:ns(str_arg(env, argv[1]))];
  if (!url) { napi_throw_error(env, nullptr, "bad url"); return nullptr; }
  [web loadRequest:[NSURLRequest requestWithURL:url]];
  return undef(env);
}

// nav(id, "back" | "forward" | "reload" | "stop")
static napi_value Nav(napi_env env, napi_callback_info info) {
  ARGS(2);
  VIEW_OR_THROW(0);
  std::string a = str_arg(env, argv[1]);
  if (a == "back") [web goBack]; else if (a == "forward") [web goForward]; else if (a == "reload") [web reload]; else if (a == "stop") [web stopLoading];
  return undef(env);
}

// focus(id)
static napi_value Focus(napi_env env, napi_callback_info info) {
  ARGS(1);
  VIEW_OR_THROW(0);
  [web.window makeFirstResponder:web];
  return undef(env);
}

// setZoom(id, factor)
static napi_value SetZoom(napi_env env, napi_callback_info info) {
  ARGS(2);
  VIEW_OR_THROW(0);
  web.pageZoom = num_arg(env, argv[1]);
  return undef(env);
}

// evaluate(id, body, isolated) -> Promise<string JSON>: `body` is an async function body; its return value comes back as JSON.
static napi_value Evaluate(napi_env env, napi_callback_info info) {
  ARGS(3);
  VIEW_OR_THROW(0);
  NSString* body = ns(str_arg(env, argv[1]));
  bool isolated = bool_arg(env, argv[2]);
  napi_deferred d; napi_value promise;
  CHECK(napi_create_promise(env, &d, &promise));
  NSString* wrapped = [NSString stringWithFormat:@"const __v = await (async () => { %@ })(); return JSON.stringify(__v === undefined ? null : __v);", body];
  [web callAsyncJavaScript:wrapped arguments:nil inFrame:nil inContentWorld:(isolated ? [WKContentWorld worldWithName:@"vibrato"] : WKContentWorld.pageWorld)
       completionHandler:^(id result, NSError* error) {
         auto* c = new Completion{ d, error == nil, "", nil };
         if (error) { NSString* m = error.userInfo[@"WKJavaScriptExceptionMessage"] ?: error.localizedDescription; c->text = std::string(m.UTF8String ?: "error"); }
         else c->text = std::string([result isKindOfClass:NSString.class] ? [(NSString*)result UTF8String] : "null");
         finish(c);
       }];
  return promise;
}

// snapshot(id) -> Promise<Buffer PNG> of the visible area at the screen's scale.
static napi_value Snapshot(napi_env env, napi_callback_info info) {
  ARGS(1);
  VIEW_OR_THROW(0);
  napi_deferred d; napi_value promise;
  CHECK(napi_create_promise(env, &d, &promise));
  WKSnapshotConfiguration* cfg = [WKSnapshotConfiguration new];
  cfg.afterScreenUpdates = YES;
  [web takeSnapshotWithConfiguration:cfg completionHandler:^(NSImage* image, NSError* error) {
    auto* c = new Completion{ d, image != nil, "", nil };
    if (!image) c->text = std::string(error.localizedDescription.UTF8String ?: "snapshot failed");
    else {
      CGImageRef cg = [image CGImageForProposedRect:nullptr context:nil hints:nil];
      NSBitmapImageRep* rep = cg ? [[NSBitmapImageRep alloc] initWithCGImage:cg] : nil;
      c->png = rep ? [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
      if (!c->png) { c->ok = false; c->text = "encode failed"; }
    }
    finish(c);
  }];
  return promise;
}

// click(id, x, y): real mouse events at a point in the view (top-left based, points). Delivered straight to the
// view under the point rather than through the event queue, so they land even while Vibrato is not the active app
// (a queued click on an inactive window would only activate it).
static napi_value Click(napi_env env, napi_callback_info info) {
  ARGS(3);
  VIEW_OR_THROW(0);
  double x = num_arg(env, argv[1]), y = num_arg(env, argv[2]);
  NSWindow* win = web.window;
  if (!win) { napi_throw_error(env, nullptr, "view has no window"); return nullptr; }
  NSPoint p = NSMakePoint(x, web.isFlipped ? y : web.bounds.size.height - y);
  NSPoint wp = [web convertPoint:p toView:nil];
  NSView* target = [web hitTest:[web.superview convertPoint:wp fromView:nil]];
  if (!target || ![target isDescendantOf:web]) target = web;
  NSTimeInterval t = NSProcessInfo.processInfo.systemUptime;
  NSEvent* move = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:wp modifierFlags:0 timestamp:t windowNumber:win.windowNumber context:nil eventNumber:0 clickCount:0 pressure:0];
  NSEvent* down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:wp modifierFlags:0 timestamp:t windowNumber:win.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1.0];
  NSEvent* up = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:wp modifierFlags:0 timestamp:t + 0.05 windowNumber:win.windowNumber context:nil eventNumber:0 clickCount:1 pressure:0];
  [target mouseMoved:move];
  [target mouseDown:down];
  [target mouseUp:up];
  return undef(env);
}

// ---------- cookies (the view's persistent store; HttpOnly ones included) ----------

static NSDictionary* cookieJson(NSHTTPCookie* c) {
  NSMutableDictionary* d = [@{ @"name": c.name ?: @"", @"value": c.value ?: @"", @"domain": c.domain ?: @"", @"path": c.path ?: @"/",
    @"httpOnly": @(c.isHTTPOnly), @"secure": @(c.isSecure), @"session": @(c.isSessionOnly) } mutableCopy];
  if (c.expiresDate) d[@"expires"] = @((long long)(c.expiresDate.timeIntervalSince1970 * 1000));
  if (@available(macOS 10.15, *)) { if (c.sameSitePolicy) d[@"sameSite"] = c.sameSitePolicy; }
  return d;
}

static std::string jsonText(id obj) {
  NSData* data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  return data ? std::string((const char*)data.bytes, data.length) : "null";
}

// cookies(id) -> Promise<string JSON array>
static napi_value Cookies(napi_env env, napi_callback_info info) {
  ARGS(1);
  VIEW_OR_THROW(0);
  napi_deferred d; napi_value promise;
  CHECK(napi_create_promise(env, &d, &promise));
  [web.configuration.websiteDataStore.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie*>* list) {
    NSMutableArray* out = [NSMutableArray arrayWithCapacity:list.count];
    for (NSHTTPCookie* c in list) [out addObject:cookieJson(c)];
    finish(new Completion{ d, true, jsonText(out), nil });
  }];
  return promise;
}

// setCookie(id, json) -> Promise: { name, value, domain, path?, expires? (ms), secure?, httpOnly?, sameSite? }
static napi_value SetCookie(napi_env env, napi_callback_info info) {
  ARGS(2);
  VIEW_OR_THROW(0);
  NSData* raw = [ns(str_arg(env, argv[1])) dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary* j = raw ? [NSJSONSerialization JSONObjectWithData:raw options:0 error:nil] : nil;
  napi_deferred d; napi_value promise;
  CHECK(napi_create_promise(env, &d, &promise));
  if (![j isKindOfClass:NSDictionary.class] || ![j[@"name"] isKindOfClass:NSString.class] || ![j[@"domain"] isKindOfClass:NSString.class]) {
    finish(new Completion{ d, false, "cookie needs name and domain", nil });
    return promise;
  }
  NSMutableDictionary* props = [@{ NSHTTPCookieName: j[@"name"], NSHTTPCookieValue: [j[@"value"] isKindOfClass:NSString.class] ? j[@"value"] : @"",
    NSHTTPCookieDomain: j[@"domain"], NSHTTPCookiePath: [j[@"path"] isKindOfClass:NSString.class] ? j[@"path"] : @"/" } mutableCopy];
  if ([j[@"expires"] isKindOfClass:NSNumber.class]) props[NSHTTPCookieExpires] = [NSDate dateWithTimeIntervalSince1970:[j[@"expires"] doubleValue] / 1000.0];
  if ([j[@"secure"] boolValue]) props[NSHTTPCookieSecure] = @"TRUE";
  if ([j[@"httpOnly"] boolValue]) props[@"HttpOnly"] = @"TRUE";
  if (@available(macOS 10.15, *)) { if ([j[@"sameSite"] isKindOfClass:NSString.class] && [j[@"sameSite"] length]) props[NSHTTPCookieSameSitePolicy] = j[@"sameSite"]; }
  NSHTTPCookie* cookie = [NSHTTPCookie cookieWithProperties:props];
  if (!cookie) { finish(new Completion{ d, false, "invalid cookie", nil }); return promise; }
  [web.configuration.websiteDataStore.httpCookieStore setCookie:cookie completionHandler:^{ finish(new Completion{ d, true, "true", nil }); }];
  return promise;
}

// deleteCookies(id, name, domain, path) -> Promise<string count>: every cookie matching name (empty = any) on domain (and path, if given).
static napi_value DeleteCookies(napi_env env, napi_callback_info info) {
  ARGS(4);
  VIEW_OR_THROW(0);
  NSString* name = ns(str_arg(env, argv[1]));
  NSString* domain = ns(str_arg(env, argv[2]));
  NSString* path = ns(str_arg(env, argv[3]));
  napi_deferred d; napi_value promise;
  CHECK(napi_create_promise(env, &d, &promise));
  WKHTTPCookieStore* store = web.configuration.websiteDataStore.httpCookieStore;
  [store getAllCookies:^(NSArray<NSHTTPCookie*>* list) {
    NSMutableArray<NSHTTPCookie*>* hits = [NSMutableArray array];
    for (NSHTTPCookie* c in list) {
      if (name.length && ![c.name isEqualToString:name]) continue;
      if (![c.domain isEqualToString:domain]) continue;
      if (path.length && ![c.path isEqualToString:path]) continue;
      [hits addObject:c];
    }
    if (!hits.count) { finish(new Completion{ d, true, "0", nil }); return; }
    __block NSUInteger left = hits.count;
    NSUInteger total = hits.count;
    for (NSHTTPCookie* c in hits) [store deleteCookie:c completionHandler:^{ if (--left == 0) finish(new Completion{ d, true, std::to_string(total), nil }); }];
  }];
  return promise;
}

// key(id, keyCode, characters, modifiers): a real key press (down + up) sent to the view, which must be first responder.
// modifiers: bit 1 shift, 2 control, 4 option, 8 command.
static napi_value Key(napi_env env, napi_callback_info info) {
  ARGS(4);
  VIEW_OR_THROW(0);
  NSWindow* win = web.window;
  if (!win) { napi_throw_error(env, nullptr, "view has no window"); return nullptr; }
  unsigned short code = (unsigned short)num_arg(env, argv[1]);
  NSString* chars = ns(str_arg(env, argv[2]));
  int mods = (int)num_arg(env, argv[3]);
  NSEventModifierFlags flags = 0;
  if (mods & 1) flags |= NSEventModifierFlagShift;
  if (mods & 2) flags |= NSEventModifierFlagControl;
  if (mods & 4) flags |= NSEventModifierFlagOption;
  if (mods & 8) flags |= NSEventModifierFlagCommand;
  if (win.firstResponder != web && !([win.firstResponder isKindOfClass:NSView.class] && [(NSView*)win.firstResponder isDescendantOf:web])) [win makeFirstResponder:web];
  // Straight to the first responder (see Click), so keys work while Vibrato is in the background.
  NSResponder* r = win.firstResponder ?: web;
  NSTimeInterval t = NSProcessInfo.processInfo.systemUptime;
  NSEvent* down = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:t windowNumber:win.windowNumber context:nil characters:chars charactersIgnoringModifiers:chars isARepeat:NO keyCode:code];
  NSEvent* up = [NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint modifierFlags:flags timestamp:t windowNumber:win.windowNumber context:nil characters:chars charactersIgnoringModifiers:chars isARepeat:NO keyCode:code];
  if (!(flags & NSEventModifierFlagCommand) || ![r performKeyEquivalent:down]) [r keyDown:down];
  [r keyUp:up];
  return undef(env);
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value name; napi_create_string_utf8(env, "vibrato-webview-done", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, nullptr, nullptr, nullptr, call_done, &g_done) == napi_ok)
    napi_unref_threadsafe_function(env, g_done);
  napi_property_descriptor props[] = {
    { "setEventHandler", nullptr, SetEventHandler, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "destroy", nullptr, Destroy, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setFrame", nullptr, SetFrame, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setVisible", nullptr, SetVisible, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "load", nullptr, Load, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "nav", nullptr, Nav, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "focus", nullptr, Focus, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setZoom", nullptr, SetZoom, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "evaluate", nullptr, Evaluate, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "click", nullptr, Click, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "key", nullptr, Key, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "cookies", nullptr, Cookies, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setCookie", nullptr, SetCookie, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "deleteCookies", nullptr, DeleteCookies, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
