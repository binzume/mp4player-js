# mp4player.js

Fetch APIでmp4を読み込み，fragmented mp4に変換しながら Media Source Extensions APIで再生するやつ．

以下の問題を回避するものです．

- video タグの srcにURLを指定 → 認証や前処理に制限がある
- FetchやXHRで読み込んでblobを再生 → 読み込み完了まで再生できない
- MPEG-DASHなどFragmented mp4にする → 事前の変換が必要

Test page : https://binzume.github.io/mp4player-js/demo/index.html

## Usage

[demo/index.html](demo/index.html)

```js
    let videoEl = document.querySelector('video');
    let videoUrl = 'videos/bunny.mp4';
    let options = {
        opener: {
            async open(pos) {
                return (await fetch(videoUrl, pos ? { headers: { 'range': 'bytes=' + pos + '-' } } : {})).body.getReader();
            }
        }
    };
    new MP4Player(videoEl).setBufferedReader(new BufferedReader(options));
```

シークするためにはRangeリクエスト必須です．

シークが不要な場合は，以下のようにread()メソッドを持つReaderを渡してください．

```js
    let videoEl = document.querySelector('video');
    let videoUrl = 'videos/bunny.mp4';
    let options = {
        reader: (await fetch(videoUrl)).body.getReader()
    };
    new MP4Player(videoEl).setBufferedReader(new BufferedReader(options));
```

### npm

https://www.npmjs.com/package/mp4player.js

```
npm i mp4player.js
node
> const {MP4Player, BufferedReader} = require('mp4player.js');
```

## TODO

- パフォーマンスの改善
- バッファ管理

# License

MIT License
