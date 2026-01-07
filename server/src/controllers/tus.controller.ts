import { All, Controller, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Endpoint } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { Permission, RouteKey } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { TusService } from 'src/services/tus.service';

@ApiExcludeController()
@Controller(RouteKey.Upload)
export class TusController {
  constructor(private service: TusService) {}

  /**
   * Handle all tus protocol requests.
   * The tus protocol uses:
   * - POST to create new uploads
   * - PATCH to upload chunks
   * - HEAD to get upload progress
   * - DELETE to cancel uploads
   * - OPTIONS for CORS preflight
   */
  @All()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Handle TUS upload request',
    description: 'TUS protocol endpoint for resumable uploads. Supports POST, PATCH, HEAD, DELETE, and OPTIONS methods.',
  })
  handleTusRequest(@Auth() auth: AuthDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    return this.service.handleTusUpload(auth, req, res);
  }

  @All('*')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Handle TUS upload request with ID',
    description: 'TUS protocol endpoint for resumable uploads with upload ID. Supports PATCH, HEAD, and DELETE methods for managing existing uploads.',
  })
  handleTusRequestWithId(@Auth() auth: AuthDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    return this.service.handleTusUpload(auth, req, res);
  }
}
