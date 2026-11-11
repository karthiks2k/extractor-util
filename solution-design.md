# Extractor Util — Solution Design

These diagrams describe the proposed extended system. The S3, PostgreSQL, and queue integrations are future extensions, not current implementations.

## Solution design

```mermaid
flowchart LR
    User[User] --> UI[Test-runner page]
    UI -->|Submit filters| API[Web app API<br/>Azure App Service]

    API -->|Create job and file records| DB[(Azure PostgreSQL)]
    API -->|Enqueue job ID| Queue[Azure Service Bus]

    Queue --> Worker[Playwright worker<br/>Container]
    Worker --> Workflow[Fixed target-page workflow<br/>Locators updated when available]
    Workflow --> Target[Authorized target page]

    Workflow --> Temp[Temporary worker storage]
    Temp -->|Upload validated file| S3[(Amazon S3)]
    Worker -->|Update job and per-file metadata| DB

    UI -->|Poll job status| API
    API -->|Read job and file status| DB

    Worker -. "Exhausted message retries" .-> DLQ[Dead-letter queue]
```

## Automation and retry flow

```mermaid
flowchart TD
    Start([User submits filters]) --> Validate{Filters valid?}
    Validate -- No --> ShowError[Show validation error]
    Validate -- Yes --> CreateJob[Create queued job in PostgreSQL]
    CreateJob --> Enqueue[Send job ID to queue]
    Enqueue --> WorkerStart[Worker receives job]
    WorkerStart --> MarkRunning[Mark job running]
    MarkRunning --> OpenPage[Open fixed target page with Playwright]
    OpenPage --> FindFiles[Find matching records]
    FindFiles --> MoreFiles{More files to process?}

    MoreFiles -- No --> Aggregate[Calculate final job status]
    Aggregate --> SaveFinal[Save final status in PostgreSQL]
    SaveFinal --> NotifyUI[UI displays results]

    MoreFiles -- Yes --> Download[Download one file to temporary storage]
    Download --> Verify{File valid?}
    Verify -- Yes --> Upload[Upload to S3 using a stable object key]
    Upload --> RecordSuccess[Save employee, file path/key, status, and attempts]
    RecordSuccess --> MoreFiles

    Verify -- No --> RetryCheck{Transient error<br/>and attempts remain?}
    RetryCheck -- Yes --> Backoff[Wait with increasing delay]
    Backoff --> Download
    RetryCheck -- No --> RecordFailure[Save file failure and error details]
    RecordFailure --> MoreFiles
```
