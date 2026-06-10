# VS Processing

## The Repository

**VS Processing** is a fork of [Code - OSS](https://github.com/microsoft/vscode) customized to deliver a near-native browser-based development experience. It adds support for writing, compiling, and running Processing Java code directly in the browser. This version is designed specifically for Advanced Placement Computer Science A (AP CSA) classrooms, enabling students to develop and run Java/Processing programs without installing any local software.

*VS Processing and its development team are not affiliated with, endorsed by, or sponsored by the Processing Foundation, the College Board, or Microsoft Corporation.*

**Try it out in your browser: [VS Processing](https://vsp.cloudtron.us)**

## Compatibility

VS Processing is designed for the latest versions of Chromium-based, Firefox-based, and Safari-based browsers. It has been tested on Chrome, Firefox, and Safari for macOS.

Mobile devices are not currently supported, although VS Processing should run on iPads.

For the best experience, we recommend using a Chromium-based browser. Chromium browsers support the File System Access API, which allows users to open folders and save files directly to their local file system. Firefox and Safari do not currently provide full support for this API, so users on those browsers may be unable to open folders or save content directly to local storage.

## Bundled Extensions

The original [Code - OSS](https://github.com/microsoft/vscode) includes a set of built-in extensions located in the [extensions](extensions) folder, including grammars and snippets for many languages. Extensions that provide rich language support (inline suggestions, Go to Definition) for a language have the suffix `language-features`. For example, the `json` extension provides coloring for `JSON` and the `json-language-features` extension provides rich language support for `JSON`.

VS Processing adds a new `webprocessing` extension that enables users to write, compile, and run Java/Processing code directly in the browser.<br>
The extension uses a modified version of TeaVM as its compiler: [WorldEditAxe/teavm-javac](https://github.com/WorldEditAxe/teavm-javac)<br>
It also uses a modified version of Eclipse JDT Language Server for linting: [CloudTronUSA/eclipse.jdt.ls-web](https://github.com/CloudTronUSA/eclipse.jdt.ls-web)

## Usage

### Project setup

1. Install Python 3 and Node.js.

2. Select the correct Node.js version:
   ```bash
   fnm use
   ```

3. Install the required build dependencies.
   On Linux, run:
   ```bash
   sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3
   ```

4. Install npm dependencies:
   ```bash
   npm install
   ```

### Run the development server for web

1. In one terminal session, start the watcher:
   ```bash
   npm run watch
   ```

2. In a second terminal session, start the web watcher:
   ```bash
   npm run watch-web
   ```

3. In a third terminal session, start VS Processing for the web:
   ```bash
   ./scripts/code-web.sh
   ```

### Build the production bundle

Run the following command:

```bash
npm run gulp vscode-web-min --max-old-space-size=49152
```
Note: This build requires approximately 30 GB of RAM.

After the production bundle is built, refer to the [deployment repository](https://github.com/CloudTronUSA/vsprocessing-deploy.git) for the next steps.

## License

VS Processing is a fork of Code - OSS, which is copyright Microsoft Corporation and licensed under the [MIT](LICENSE.txt) License.

Modifications made for VS Processing are copyright the VS Processing contributors and are also licensed under the [MIT](LICENSE.txt) License, unless otherwise noted.
