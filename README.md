# mp4.js [WIP]

Fetch APIでmp4を読み込み，ブラウザ上でfragmented mp4に変換しながら Media Source Extensions APIで再生するやつ．

以下の問題を回避するものです．

- video タグの srcにURLを指定 → 認証や前処理に制限がある
- FetchやXHRで読み込んでblobを再生 → 読み込み完了まで再生できない
- MPEG-DASHなどFragmented mp4にする → 事前の変換が必要

今の所 PoC レベルなので，とりあえず再生開始できるだけです．

## TODO

- シーク対応
- バッファリング
- リクエスト回数減らす
- まともな実装にする

# License

MIT License
