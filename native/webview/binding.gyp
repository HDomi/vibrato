{
  "targets": [{
    "target_name": "vibrato_webview",
    "sources": ["src/webview.mm"],
    "xcode_settings": {
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "MACOSX_DEPLOYMENT_TARGET": "13.3",
      "OTHER_CPLUSPLUSFLAGS": ["-std=c++20", "-fobjc-arc"]
    },
    "link_settings": { "libraries": ["-framework WebKit", "-framework AppKit"] }
  }]
}
