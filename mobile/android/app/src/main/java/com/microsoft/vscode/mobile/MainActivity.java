package com.microsoft.vscode.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		WebView webView = getBridge().getWebView();
		WebSettings webSettings = webView.getSettings();

		// Allow mixed content (HTTP resources from HTTPS page)
		webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

		// Allow JavaScript to open windows
		webSettings.setJavaScriptCanOpenWindowsAutomatically(true);
		webSettings.setSupportMultipleWindows(true);

		// Add a JS interface to open external URLs
		webView.addJavascriptInterface(new Object() {
			@JavascriptInterface
			public void openExternal(String url) {
				Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
				startActivity(intent);
			}
		}, "MobileNative");

		// Override window.open to use the native bridge for external URLs
		webView.evaluateJavascript(
			"(function() {" +
			"  const _originalOpen = window.open;" +
			"  window.open = function(url, target, features) {" +
			"    if (url && (url.includes('github.com') || url.includes('microsoft.com') || url.includes('live.com') || url.includes('login'))) {" +
			"      if (window.MobileNative) { window.MobileNative.openExternal(url); }" +
			"      return null;" +
			"    }" +
			"    return _originalOpen ? _originalOpen.call(window, url, target, features) : null;" +
			"  };" +
			"})();",
			null
		);

		// Also handle onCreateWindow for popup windows
		webView.setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
			@Override
			public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
				// Extract URL from the hit test or transport
				WebView.HitTestResult result = view.getHitTestResult();
				String url = result.getExtra();
				if (url != null && !url.isEmpty()) {
					Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
					startActivity(intent);
					return false;
				}
				// For programmatic window.open, create a temp WebView to capture the URL
				WebView tempView = new WebView(view.getContext());
				tempView.setWebViewClient(new android.webkit.WebViewClient() {
					@Override
					public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest request) {
						Intent intent = new Intent(Intent.ACTION_VIEW, request.getUrl());
						startActivity(intent);
						return true;
					}
				});
				WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
				transport.setWebView(tempView);
				resultMsg.sendToTarget();
				return true;
			}
		});
	}
}
