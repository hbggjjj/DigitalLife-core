// SPDX-License-Identifier: AGPL-3.0-or-later
package digitallife.channel;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/**
 * 双人通道的最小客户端：只有四个动作。
 *   history(since) / send(text) / upload(bytes) / read(id)
 *
 * 身份三件套：
 *   ① mTLS 客户端证书（assets/client.p12，自己用 scripts/gen-certs.sh 签）
 *   ② X-Channel-Token（服务器 systemd 里的 CHANNEL_TOKEN）
 *   ③ X-Device-Pin （服务器只存 sha256；没有它，服务器会 401 PIN_REQUIRED）
 */
public class Channel {
    private final String base;
    private final String token;
    private final String pin;
    private final SSLSocketFactory factory;

    public Channel(String base, String token, String pin, SSLSocketFactory factory) {
        this.base = base.replaceAll("/+$", "");
        this.token = token == null ? "" : token;
        this.pin = pin == null ? "" : pin;
        this.factory = factory;
    }

    /** 用 assets/client.p12 + assets/ca.crt 建 TLS：客户端证书 + 只信这个 CA */
    public static SSLSocketFactory buildTls(android.content.Context ctx, String p12Pass) {
        try {
            KeyStore ks = KeyStore.getInstance("PKCS12");
            try (InputStream in = ctx.getAssets().open("client.p12")) {
                ks.load(in, p12Pass.toCharArray());
            }
            KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            kmf.init(ks, p12Pass.toCharArray());

            KeyStore ts = KeyStore.getInstance(KeyStore.getDefaultType());
            ts.load(null, null);
            try (InputStream in = ctx.getAssets().open("ca.crt")) {
                CertificateFactory cf = CertificateFactory.getInstance("X.509");
                X509Certificate ca = (X509Certificate) cf.generateCertificate(in);
                ts.setCertificateEntry("ca", ca);
            }
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(ts);

            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(kmf.getKeyManagers(), tmf.getTrustManagers(), new SecureRandom());
            return sc.getSocketFactory();
        } catch (Exception e) {
            return null;
        }
    }

    private HttpURLConnection open(String method, String path, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(15000);
        if (c instanceof HttpsURLConnection && factory != null) {
            ((HttpsURLConnection) c).setSSLSocketFactory(factory);
        }
        if (!token.isEmpty()) c.setRequestProperty("X-Channel-Token", token);
        if (!pin.isEmpty()) c.setRequestProperty("X-Device-Pin", pin);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
        }
        return c;
    }

    private static String body(HttpURLConnection c) throws Exception {
        InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toString("UTF-8");
    }

    /** 返回 [{id, at, dir, text, images}] 与 hasMore */
    public JSONObject history(long since) throws Exception {
        HttpURLConnection c = open("GET", "/history?since=" + Math.max(0, since) + "&limit=200", null);
        return new JSONObject(body(c));
    }

    /** 发送文本或图片；成功返回 true。PIN 不对会抛 PinException。 */
    public void send(String text, String mediaPath) throws Exception {
        JSONObject b = new JSONObject();
        b.put("text", text == null ? "" : text);
        if (mediaPath != null) {
            JSONArray a = new JSONArray();
            JSONObject im = new JSONObject();
            im.put("path", mediaPath);
            a.put(im);
            b.put("images", a);
        }
        HttpURLConnection c = open("POST", "/send", b.toString());
        if (c.getResponseCode() == 401) throw new PinException(body(c));
        if (c.getResponseCode() >= 400) throw new Exception("发送失败 HTTP " + c.getResponseCode());
    }

    public void markRead(long id) throws Exception {
        JSONObject b = new JSONObject();
        b.put("id", id);
        open("POST", "/read", b.toString()).getResponseCode();
    }

    /** 上传一张图，返回 /media/... 路径 */
    public String upload(byte[] data, String ext) throws Exception {
        HttpURLConnection c = open("POST", "/upload?ext=" + ext, null);
        // 图片是原始字节，不是 JSON
        c.setRequestProperty("Content-Type", "application/octet-stream");
        c.getOutputStream().write(data);
        if (c.getResponseCode() >= 400) throw new Exception("上传失败 HTTP " + c.getResponseCode());
        JSONObject d = new JSONObject(body(c));
        return "/media/" + d.optString("name");
    }

    public byte[] media(String path) throws Exception {
        HttpURLConnection c = open("GET", path, null);
        if (c.getResponseCode() != 200) throw new Exception("取图失败 " + c.getResponseCode());
        InputStream in = c.getInputStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    public boolean healthy() {
        try {
            return new JSONObject(body(open("GET", "/health", null))).optBoolean("ok");
        } catch (Exception e) { return false; }
    }

    public static class PinException extends Exception {
        public PinException(String m) { super(m); }
    }
}
