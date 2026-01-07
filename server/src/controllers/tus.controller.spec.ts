import { TusController } from 'src/controllers/tus.controller';
import { TusService } from 'src/services/tus.service';
import request from 'supertest';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils';

describe(TusController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(TusService);

  beforeAll(async () => {
    ctx = await controllerSetup(TusController, [{ provide: TusService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('ALL /upload', () => {
    it('should be an authenticated route', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(200).send();
      });
      await request(ctx.getHttpServer()).post('/upload');
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should call service.handleTusUpload for POST', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(200).send();
      });

      await request(ctx.getHttpServer())
        .post('/upload')
        .set('Upload-Length', '1000')
        .set('Upload-Metadata', 'filename dGVzdC5qcGc=');

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('POST');
    });

    it('should call service.handleTusUpload for PATCH', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(204).send();
      });

      await request(ctx.getHttpServer())
        .patch('/upload')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream');

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('PATCH');
    });

    it('should call service.handleTusUpload for HEAD', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(200).send();
      });

      await request(ctx.getHttpServer()).head('/upload');

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('HEAD');
    });

    it('should call service.handleTusUpload for DELETE', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(204).send();
      });

      await request(ctx.getHttpServer()).delete('/upload');

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('DELETE');
    });

    it('should call service.handleTusUpload for OPTIONS', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(204).send();
      });

      await request(ctx.getHttpServer()).options('/upload');

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('OPTIONS');
    });

    it('should handle service errors', async () => {
      service.handleTusUpload.mockRejectedValue(new Error('Service error'));

      const { status } = await request(ctx.getHttpServer()).post('/upload');

      expect(status).toBe(500);
    });
  });

  describe('ALL /upload/:id', () => {
    const uploadId = 'test-upload-id-123';

    it('should be an authenticated route', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(200).send();
      });
      await request(ctx.getHttpServer()).post(`/upload/${uploadId}`);
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should call service.handleTusUpload with upload ID in params for POST', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(200).send();
      });

      await request(ctx.getHttpServer())
        .post(`/upload/${uploadId}`)
        .set('Upload-Length', '1000');

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('POST');
      expect(req.params.id).toBe(uploadId);
    });

    it('should call service.handleTusUpload for PATCH with upload ID', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(204).send();
      });

      await request(ctx.getHttpServer())
        .patch(`/upload/${uploadId}`)
        .set('Upload-Offset', '500')
        .set('Content-Type', 'application/offset+octet-stream')
        .send(Buffer.from('test data'));

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('PATCH');
      expect(req.params.id).toBe(uploadId);
    });

    it('should call service.handleTusUpload for HEAD with upload ID', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(200).send();
      });

      await request(ctx.getHttpServer()).head(`/upload/${uploadId}`);

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('HEAD');
      expect(req.params.id).toBe(uploadId);
    });

    it('should call service.handleTusUpload for DELETE with upload ID', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(204).send();
      });

      await request(ctx.getHttpServer()).delete(`/upload/${uploadId}`);

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('DELETE');
      expect(req.params.id).toBe(uploadId);
    });

    it('should call service.handleTusUpload for OPTIONS with upload ID', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(204).send();
      });

      await request(ctx.getHttpServer()).options(`/upload/${uploadId}`);

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.method).toBe('OPTIONS');
      expect(req.params.id).toBe(uploadId);
    });

    it('should handle service errors', async () => {
      service.handleTusUpload.mockRejectedValue(new Error('Service error'));

      const { status } = await request(ctx.getHttpServer()).patch(`/upload/${uploadId}`);

      expect(status).toBe(500);
    });

    it('should handle different upload IDs', async () => {
      service.handleTusUpload.mockImplementation(async (_auth, _req, res) => {
        res.status(200).send();
      });
      const differentId = 'different-upload-id-456';

      await request(ctx.getHttpServer()).head(`/upload/${differentId}`);

      expect(service.handleTusUpload).toHaveBeenCalledTimes(1);
      const [, req] = service.handleTusUpload.mock.calls[0];
      expect(req.params.id).toBe(differentId);
    });
  });
});
