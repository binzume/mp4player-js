# mp4player.js [WIP]

Fetch APIでmp4を読み込み，ブラウザ上でfragmented mp4に変換しながら Media Source Extensions APIで再生するやつ．

以下の問題を回避するものです．

- video タグの srcにURLを指定 → 認証や前処理に制限がある
- FetchやXHRで読み込んでblobを再生 → 読み込み完了まで再生できない
- MPEG-DASHなどFragmented mp4にする → 事前の変換が必要

今の所 PoC レベルなので，とりあえず再生できるだけです．

Test page : https://binzume.github.io/mp4player-js/index.html

## TODO

- まともな実装にする
- パフォーマンスの改善
- バッファ管理

# License

MIT License
