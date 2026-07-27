# Browseright

Open WebUI tool allowing agents to access a full web browser.

> [!NOTE]
> Feel free to open pull requests or fork the tool for your need. <br />
> Vibe coding is allowed in pull requests for this repo, so go wild.

# Usage

### Prerequisites
*   Node.js (v18 or higher recommended)
*   npm or yarn
*   xvfb (Optional) 

### Installation Steps

1.  **Clone the repository**
    ```bash
    git clone https://github.com/tbvns/browseright.git
    cd browseright
    ```

2.  **Install dependencies**
    ```bash
    npm install
    npx patchright install
    ```

3.  **Run the server**
    ```bash
    node ./main.js
    ```
    if you have any errors saying it was unable to find a suitable screen, or is complaining about running in a headless environment, use:    
    ```bash
    xvfb-run node ./main.js
    ```

4. **Install the tool**
   Copy `Browseright-OpenWebUI.py` into a new Open-WebUI tool.

> [!CAUTION]
> Vibe coded and made for my personal usage. Do not use in real production environment. <br /> I won't provide any support on this.
