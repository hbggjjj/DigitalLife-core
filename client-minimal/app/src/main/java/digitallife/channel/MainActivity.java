// SPDX-License-Identifier: AGPL-3.0-or-later
package digitallife.channel;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 最素的通道客户端：没有动画、没有主题、没有花活。
 * 只做四件事：填配置 → 拉历史 → 发消息 → 显示。
 * 协议和验证跟正式客户端完全一致（mTLS + token + PIN）。
 */
public class MainActivity extends Activity {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences sp;
    private Channel ch;
    private long since = 0;

    private LinearLayout list;
    private EditText input;
    private ScrollView scroll;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        sp = getSharedPreferences("cfg", MODE_PRIVATE);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout cfg = new LinearLayout(this);
        cfg.setOrientation(LinearLayout.VERTICAL);
        cfg.setPadding(24, 24, 24, 12);
        EditText url = field("通道地址，例如 https://1.2.3.4:7792", sp.getString("url", ""));
        EditText token = field("CHANNEL_TOKEN", sp.getString("token", ""));
        EditText pin = field("DEVICE_PIN（4 位数字）", sp.getString("pin", ""));
        pin.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        Button connect = new Button(this);
        connect.setText("连接");
        cfg.addView(url); cfg.addView(token); cfg.addView(pin); cfg.addView(connect);
        root.addView(cfg, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        scroll = new ScrollView(this);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(24, 12, 24, 12);
        scroll.addView(list);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(16, 8, 16, 16);
        input = new EditText(this);
        input.setHint("发给她…");
        bar.addView(input, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button send = new Button(this);
        send.setText("发送");
        bar.addView(send);
        root.addView(bar);

        setContentView(root);

        connect.setOnClickListener(v -> {
            sp.edit().putString("url", url.getText().toString().trim())
              .putString("token", token.getText().toString().trim())
              .putString("pin", pin.getText().toString().trim()).apply();
            connect(url.getText().toString().trim(), token.getText().toString().trim(), pin.getText().toString().trim());
        });

        send.setOnClickListener(v -> {
            String t = input.getText().toString().trim();
            if (t.isEmpty() || ch == null) return;
            input.setText("");
            io.execute(() -> {
                try {
                    ch.send(t, null);
                    poll();
                } catch (Channel.PinException e) {
                    ui.post(() -> toast("PIN 不对：这条没有发出去"));
                } catch (Exception e) {
                    ui.post(() -> toast("发送失败：" + e.getMessage()));
                }
            });
        });

        // 已经存过配置就直接连
        if (!sp.getString("url", "").isEmpty()) {
            connect(sp.getString("url", ""), sp.getString("token", ""), sp.getString("pin", ""));
        }
    }

    private EditText field(String hint, String value) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(value);
        return e;
    }

    private void connect(String url, String token, String pin) {
        javax.net.ssl.SSLSocketFactory f = Channel.buildTls(this, "CHANGE_ME");
        if (f == null) { toast("证书加载失败：检查 assets/client.p12 和 ca.crt"); return; }
        ch = new Channel(url, token, pin, f);
        io.execute(() -> {
            if (!ch.healthy()) { ui.post(() -> toast("连不上：地址 / 证书 / token 不对")); return; }
            since = 0;
            ui.post(() -> { list.removeAllViews(); toast("已连接"); });
            poll();
        });
    }

    private void poll() {
        long at = since;
        io.execute(() -> {
            try {
                JSONObject d = ch.history(at);
                JSONArray arr = d.optJSONArray("messages");
                if (arr == null) return;
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject m = arr.getJSONObject(i);
                    long id = m.optLong("id");
                    if (id > since) since = id;
                    ui.post(() -> addRow(m));
                }
                ui.postDelayed(this::poll, 4000);
            } catch (Exception e) {
                ui.postDelayed(this::poll, 8000);
            }
        });
    }

    private void addRow(JSONObject m) {
        boolean mine = "in".equals(m.optString("dir"));
        TextView t = new TextView(this);
        t.setText(m.optString("text"));
        t.setTextSize(15);
        t.setPadding(16, 10, 16, 10);
        t.setGravity(mine ? Gravity.END : Gravity.START);
        list.addView(t);
        scroll.post(() -> scroll.fullScroll(ScrollView.FOCUS_DOWN));
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }

    @Override protected void onDestroy() { super.onDestroy(); io.shutdownNow(); }
}
